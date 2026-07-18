import { findNearestStation, getLiveRoute, mapsDeepLink, haversineKm } from './routing.js';
import { supabase, isSupabaseConfigured } from './supabase-config.js';
import { seedCrowdDemo } from './seed.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
let stations = [];

const state = {
  currentPosition: null,
  nearest: null,
  language: 'en',
  voiceMuted: false,
  crowdChannel: null,
  crowdReports: [],
  audio: null,
  motionHandler: null,
};

const $ = (id) => document.getElementById(id);
const els = {
  locationStatus: $('location-status'), metroLine: $('metro-line'), stationName: $('station-name'),
  stationDistance: $('station-distance'), stationAttraction: $('station-attraction'), hospitalName: $('hospital-name'),
  hospitalTimes: $('hospital-times'), policeName: $('police-name'), policeTimes: $('police-times'),
  routeBtn: $('route-btn'), routeOutput: $('route-output'), crowdBadge: $('crowd-badge'),
  crowdMessage: $('crowd-message'), langSelect: $('lang-select'), muteToggle: $('mute-toggle'),
  musicToggle: $('music-toggle'), locateBtn: $('locate-btn'), motionStatus: $('motion-status'),
  motionIntensity: $('motion-intensity'), beatCount: $('beat-count'), beatTempo: $('beat-tempo'),
  rhythmOrb: $('rhythm-orb'), motionHelp: $('motion-help'), rhythmStation: $('rhythm-station'),
  rhythmDistance: $('rhythm-distance'), crowdStation: $('crowd-station'), guideStation: $('guide-station'),
  aiCompose: $('ai-compose'),
  locationToggle: $('location-toggle'), crowdThreshold: $('crowd-threshold'), crowdAlert: $('crowd-alert'),
  motionSensitivity: $('motion-sensitivity'), testBeat: $('test-beat'),
};

async function loadStations() {
  const response = await fetch('./kochi_metro_stations.json');
  if (!response.ok) throw new Error(`Station data returned ${response.status}`);
  const payload = await response.json();
  stations = (payload.stations || payload).slice().sort((a, b) => a.order - b.order);
}

function renderLine() {
  els.metroLine.replaceChildren();
  stations.forEach((station, index) => {
    const item = document.createElement('li');
    item.className = 'station-stop';
    if (station.station === state.nearest?.station) item.classList.add('active');
    item.setAttribute('aria-label', station.station);
    item.innerHTML = `<span class="station-dot" aria-hidden="true"></span><span class="station-label">${station.station}</span>`;
    els.metroLine.append(item);
    if (station.station === state.nearest?.station) {
      requestAnimationFrame(() => item.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }));
    }
  });
  if (Number.isFinite(state.lineProgress)) {
    const train = document.createElement('span');
    train.className = 'train-marker';
    train.style.left = `${64 + state.lineProgress * 72}px`;
    train.textContent = '🚇';
    train.setAttribute('aria-label', `Your train is near ${state.nearest?.station || 'the metro line'}`);
    els.metroLine.append(train);
  }
}

function projectOntoMetroLine(latitude, longitude) {
  let best = { progress: 0, distance: Infinity };
  const latScale = 111.32;
  const lngScale = 111.32 * Math.cos(latitude * Math.PI / 180);
  for (let index = 0; index < stations.length - 1; index += 1) {
    const a = stations[index]; const b = stations[index + 1];
    const bx = (b.lng - a.lng) * lngScale; const by = (b.lat - a.lat) * latScale;
    const px = (longitude - a.lng) * lngScale; const py = (latitude - a.lat) * latScale;
    const lengthSquared = bx * bx + by * by;
    const t = Math.max(0, Math.min(1, lengthSquared ? (px * bx + py * by) / lengthSquared : 0));
    const projectedLat = a.lat + (b.lat - a.lat) * t;
    const projectedLng = a.lng + (b.lng - a.lng) * t;
    const distance = haversineKm(latitude, longitude, projectedLat, projectedLng);
    if (distance < best.distance) best = { progress: index + t, distance };
  }
  return best;
}

function updateStationCard(station, distanceKm) {
  els.stationName.textContent = station.station;
  els.stationDistance.textContent = `${distanceKm.toFixed(2)} km from your position`;
  els.stationAttraction.textContent = station.attraction;
  els.hospitalName.textContent = station.hospital;
  els.hospitalTimes.textContent = `Walk ${station.hospital_walk_min} min · Auto ${station.hospital_auto_min} min`;
  els.policeName.textContent = station.police;
  els.policeTimes.textContent = `Walk ${station.police_walk_min} min · Auto ${station.police_auto_min} min`;
  els.routeOutput.textContent = 'Tap to find the hospital route.';
  els.rhythmStation.textContent = station.station;
  els.rhythmDistance.textContent = `${distanceKm.toFixed(2)} km from your live position`;
  els.crowdStation.textContent = station.station;
  els.guideStation.textContent = station.station;
  renderLine();
  announce(station);
  refreshCrowd();
}

function announcement(station) {
  const en = `Approaching ${station.station}. Nearest hospital: ${station.hospital}, ${station.hospital_walk_min} minutes. Nearest police station: ${station.police}, ${station.police_walk_min} minutes.`;
  if (state.language === 'ml') return `അടുത്തെത്തുന്നത് ${station.station}. ഏറ്റവും അടുത്ത ആശുപത്രി: ${station.hospital}, ${station.hospital_walk_min} മിനിറ്റ്. ഏറ്റവും അടുത്ത പോലീസ് സ്റ്റേഷൻ: ${station.police}, ${station.police_walk_min} മിനിറ്റ്.`;
  if (state.language === 'hi') return `${station.station} आ रहा है। निकटतम अस्पताल: ${station.hospital}, ${station.hospital_walk_min} मिनट। निकटतम पुलिस स्टेशन: ${station.police}, ${station.police_walk_min} मिनट।`;
  return en;
}

function announce(station, force = false) {
  if (state.voiceMuted || !('speechSynthesis' in window) || (!force && station.station === state.lastSpoken)) return;
  state.lastSpoken = station.station;
  const language = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN' }[state.language];
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((item) => item.lang.toLowerCase() === language.toLowerCase())
    || voices.find((item) => item.lang.toLowerCase().startsWith(state.language))
    || voices.find((item) => item.lang.toLowerCase() === 'en-in');
  const utterance = new SpeechSynthesisUtterance(announcement(station));
  utterance.lang = voice?.lang || language;
  if (voice) utterance.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function handlePosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  if (accuracy > 250 && state.currentPosition) return;
  state.currentPosition = { latitude, longitude };
  const rawNearest = findNearestStation(latitude, longitude, stations);
  if (state.stationIndex == null) {
    state.stationIndex = stations.indexOf(rawNearest.station);
  }
  let current = stations[state.stationIndex];
  let currentDistance = haversineKm(latitude, longitude, current.lat, current.lng);
  // If tracking resumes in a completely different area, safely reacquire once.
  if (currentDistance > 2 && rawNearest.distanceKm + 0.4 < currentDistance) {
    state.stationIndex = stations.indexOf(rawNearest.station);
    current = stations[state.stationIndex];
    currentDistance = rawNearest.distanceKm;
  } else {
    const adjacent = [state.stationIndex - 1, state.stationIndex + 1]
      .filter((index) => index >= 0 && index < stations.length)
      .map((index) => ({ index, distance: haversineKm(latitude, longitude, stations[index].lat, stations[index].lng) }))
      .sort((a, b) => a.distance - b.distance)[0];
    // Cross the geographic midpoint, plus 35 m of hysteresis, before changing.
    if (adjacent && adjacent.distance + 0.035 < currentDistance) {
      state.stationIndex = adjacent.index;
      current = stations[state.stationIndex];
      currentDistance = adjacent.distance;
    }
  }
  const neighborCandidates = [state.stationIndex - 1, state.stationIndex + 1]
    .filter((index) => index >= 0 && index < stations.length)
    .map((index) => ({ index, distance: haversineKm(latitude, longitude, stations[index].lat, stations[index].lng) }))
    .sort((a, b) => a.distance - b.distance);
  const next = neighborCandidates[0];
  if (next) {
    const ratio = currentDistance / Math.max(0.001, currentDistance + next.distance);
    const rawProgress = state.stationIndex + Math.sign(next.index - state.stationIndex) * Math.min(0.49, ratio);
    state.lineProgress = state.lineProgress == null ? rawProgress : state.lineProgress * 0.72 + rawProgress * 0.28;
  } else state.lineProgress = state.stationIndex;
  const trackedStation = stations[state.stationIndex];
  const result = { station: trackedStation, distanceKm: haversineKm(latitude, longitude, trackedStation.lat, trackedStation.lng) };
  els.locationStatus.textContent = `Live · ±${Math.round(accuracy)} m`;
  els.locationStatus.className = 'status-pill live';
  const changed = result.station.station !== state.nearest?.station;
  state.nearest = result.station;
  state.nearestDistance = result.distanceKm;
  if (changed) {
    updateStationCard(result.station, result.distanceKm);
  } else {
    const distance = `${result.distanceKm.toFixed(2)} km from your live position`;
    els.stationDistance.textContent = distance;
    els.rhythmDistance.textContent = distance;
    renderLine();
  }
}

function startLocation() {
  if (state.watchId != null) return;
  if (!navigator.geolocation) {
    els.locationStatus.textContent = 'GPS unavailable';
    return;
  }
  els.locationStatus.textContent = 'Finding you…';
  state.watchId = navigator.geolocation.watchPosition(handlePosition, (error) => {
    els.locationStatus.textContent = error.code === 1 ? 'Location permission needed' : 'GPS unavailable';
    els.locationStatus.className = 'status-pill error';
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  els.locationToggle.textContent = '■ Stop location';
  els.locateBtn.textContent = '■ Stop location';
}

function stopLocation() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  els.locationStatus.textContent = 'GPS off';
  els.locationStatus.className = 'status-pill';
  els.locationToggle.textContent = '⌖ Start location';
  els.locateBtn.textContent = '⌖ Start location';
  window.speechSynthesis?.cancel();
}

function toggleLocation() {
  if (state.watchId == null) startLocation(); else stopLocation();
}

function hospitalSearch(station) {
  return station.hospital.replace(/\s*-\s*~.*$/, '').replace(/\s*\/.*$/, '');
}

async function handleRoute() {
  if (!state.nearest || !state.currentPosition) {
    els.routeOutput.textContent = 'Enable location first.';
    return;
  }
  const station = state.nearest;
  els.routeBtn.disabled = true;
  els.routeOutput.textContent = 'Finding a live route…';
  try {
    // The supplied station file has no hospital coordinates. Use a Maps place query;
    // if future data adds coordinates, the live OSRM route is used automatically.
    if (Number.isFinite(station.hospital_lat) && Number.isFinite(station.hospital_lng)) {
      const route = await getLiveRoute(state.currentPosition.latitude, state.currentPosition.longitude, station.hospital_lat, station.hospital_lng, 'walking');
      if (route) {
        els.routeOutput.textContent = `${route.distanceKm} km · ${route.durationMin} min walk`;
        return;
      }
      showMapLink(mapsDeepLink(station.hospital_lat, station.hospital_lng, 'walking'));
      return;
    }
    const destination = encodeURIComponent(`${hospitalSearch(station)}, Kochi, Kerala`);
    showMapLink(`https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`);
  } finally {
    els.routeBtn.disabled = false;
  }
}

function showMapLink(href) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open in Google Maps ↗';
  els.routeOutput.replaceChildren(link);
}

function crowdStatus(reports) {
  if (!reports.length) return { label: 'No recent reports', tone: 'neutral' };
  const average = reports.reduce((sum, row) => sum + Number(row.level), 0) / reports.length;
  if (average >= 2.5) return { label: 'High crowd', tone: 'high' };
  if (average >= 1.5) return { label: 'Medium crowd', tone: 'medium' };
  return { label: 'Low crowd', tone: 'low' };
}

function paintCrowd(reports) {
  const status = crowdStatus(reports);
  const average = reports.length ? reports.reduce((sum, row) => sum + Number(row.level), 0) / reports.length : 0;
  els.crowdBadge.textContent = `${status.label} · ${reports.length} report${reports.length === 1 ? '' : 's'}`;
  els.crowdBadge.className = `crowd-badge ${status.tone}`;
  const threshold = Number(els.crowdThreshold.value);
  const shouldAlert = reports.length > 0 && average >= threshold;
  els.crowdAlert.hidden = !shouldAlert;
  const alertKey = `${state.nearest?.station}:${status.tone}:${threshold}`;
  if (shouldAlert && state.lastCrowdAlert !== alertKey) {
    state.lastCrowdAlert = alertKey;
    navigator.vibrate?.([180, 80, 180]);
  }
  if (!shouldAlert) state.lastCrowdAlert = null;
}

async function refreshCrowd() {
  if (!state.nearest) return;
  const stationName = state.nearest.station;
  if (!isSupabaseConfigured) {
    paintCrowd(state.crowdReports.filter((row) => row.station === stationName && Date.now() - new Date(row.created_at) < FIFTEEN_MINUTES));
    els.crowdMessage.textContent = 'Demo data is stored on this device. Add Supabase credentials for shared live reports.';
    return;
  }
  const since = new Date(Date.now() - FIFTEEN_MINUTES).toISOString();
  const { data, error } = await supabase.from('crowd_reports').select('level, station, created_at').eq('station', stationName).gte('created_at', since);
  if (error) {
    els.crowdMessage.textContent = 'Crowd service is temporarily unavailable.';
    return;
  }
  paintCrowd(data || []);
}

async function reportCrowd(level) {
  if (!state.nearest) {
    els.crowdMessage.textContent = 'Wait for your nearest station before reporting.';
    return;
  }
  const row = { station: state.nearest.station, level, created_at: new Date().toISOString() };
  if (isSupabaseConfigured) {
    const { error } = await supabase.from('crowd_reports').insert({ station: row.station, level });
    els.crowdMessage.textContent = error ? 'Could not send report. Please retry.' : 'Thanks — your report is live.';
  } else {
    state.crowdReports.push(row);
    localStorage.setItem('metro-saathi-reports', JSON.stringify(state.crowdReports));
    els.crowdMessage.textContent = 'Thanks — demo report saved on this device.';
  }
  await refreshCrowd();
}

function subscribeCrowd() {
  if (!isSupabaseConfigured) return;
  state.crowdChannel = supabase.channel('metro-saathi-crowd').on('postgres_changes', {
    event: 'INSERT', schema: 'public', table: 'crowd_reports',
  }, refreshCrowd).subscribe();
  setInterval(refreshCrowd, 30000);
}

function motionPulse(event) {
  const a = event.acceleration || event.accelerationIncludingGravity;
  if (!a || !state.audio) return;
  state.lastMotionEvent = performance.now();
  els.motionStatus.textContent = 'Listening live';
  els.motionStatus.className = 'status-pill live';
  const raw = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  state.motionBaseline = state.motionBaseline == null ? raw : state.motionBaseline * 0.92 + raw * 0.08;
  const magnitude = Math.abs(raw - state.motionBaseline);
  const visualIntensity = Math.min(10, magnitude * 2.2);
  state.motionSamples = [...(state.motionSamples || []), visualIntensity].slice(-240);
  els.motionIntensity.textContent = visualIntensity.toFixed(1);
  els.rhythmOrb.style.setProperty('--motion', `${1 + visualIntensity / 28}`);
  state.audio.master.gain.setTargetAtTime(0.025 + Math.min(magnitude, 5) * 0.006, state.audio.context.currentTime, 0.08);
  if (magnitude < 0.85 || performance.now() - (state.lastPulse || 0) < 180) return;
  const previousPulse = state.lastPulse;
  state.lastPulse = performance.now();
  state.beatCount = (state.beatCount || 0) + 1;
  els.beatCount.textContent = state.beatCount;
  if (previousPulse) {
    const interval = state.lastPulse - previousPulse;
    state.beatIntervals = [...(state.beatIntervals || []), interval].slice(-8);
    const average = state.beatIntervals.reduce((sum, value) => sum + value, 0) / state.beatIntervals.length;
    els.beatTempo.textContent = Math.min(240, Math.round(60000 / average));
  }
  els.rhythmOrb.classList.remove('hit');
  void els.rhythmOrb.offsetWidth;
  els.rhythmOrb.classList.add('hit');
  const now = state.audio.context.currentTime;
  const strength = Math.min(1, 0.25 + magnitude / 5);

  // Low wheel thump: acceleration controls pitch and impact.
  const kick = state.audio.context.createOscillator();
  const kickGain = state.audio.context.createGain();
  kick.type = 'sine';
  kick.frequency.setValueAtTime(125 + magnitude * 12, now);
  kick.frequency.exponentialRampToValueAtTime(42, now + 0.22);
  kickGain.gain.setValueAtTime(0.035 + strength * 0.11, now);
  kickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
  kick.connect(kickGain).connect(state.audio.master);
  kick.start(now); kick.stop(now + 0.25);

  // Alternating metallic rail click makes irregular train motion musical.
  const click = state.audio.context.createOscillator();
  const clickGain = state.audio.context.createGain();
  click.type = state.beatCount % 2 ? 'square' : 'triangle';
  click.frequency.setValueAtTime(state.beatCount % 4 === 0 ? 920 : 620 + magnitude * 35, now);
  click.frequency.exponentialRampToValueAtTime(240, now + 0.055);
  clickGain.gain.setValueAtTime(0.018 + strength * 0.035, now);
  clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
  click.connect(clickGain).connect(state.audio.master);
  click.start(now); click.stop(now + 0.08);

  // Each detected beat moves the ambient harmony through the AI recipe.
  const recipe = state.composition || { rootHz: 73.42, intervals: [1, 1.5] };
  const chord = recipe.intervals[state.beatCount % recipe.intervals.length] || 1;
  state.audio.oscillators?.forEach((oscillator, index) => {
    const octave = index === 2 ? 2 : 1;
    oscillator.frequency.setTargetAtTime(recipe.rootHz * chord * octave, now, 0.35);
  });
}

async function toggleMusic() {
  if (state.audio) {
    window.removeEventListener('devicemotion', state.motionHandler);
    await state.audio.context.close();
    state.audio = null;
    els.musicToggle.textContent = '▶ Start listening to the train';
    els.motionStatus.textContent = 'Sensor off';
    els.motionStatus.className = 'status-pill';
    els.motionHelp.textContent = 'Rhythm stopped. Tap to listen again.';
    els.motionIntensity.textContent = '0.0';
    return;
  }
  if (typeof window.DeviceMotionEvent?.requestPermission === 'function') {
    if (await window.DeviceMotionEvent.requestPermission() !== 'granted') {
      els.motionHelp.textContent = 'Motion access was denied. Allow it in browser settings and retry.';
      return;
    }
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  state.lastMotionEvent = null;
  const master = context.createGain(); master.gain.value = 0.035; master.connect(context.destination);
  const composition = state.composition || { rootHz: 73.42, intervals: [1, 1.5], waveforms: ['triangle', 'sine'], label: 'Metro ambient' };
  const oscillators = [];
  composition.intervals.slice(0, 3).forEach((interval, index) => {
    const osc = context.createOscillator(); const gain = context.createGain();
    osc.type = composition.waveforms[index] || (index ? 'sine' : 'triangle');
    osc.frequency.value = composition.rootHz * interval;
    gain.gain.value = index ? 0.25 : 0.5;
    osc.connect(gain).connect(master); osc.start();
    oscillators.push(osc);
  });
  state.audio = { context, master, oscillators };
  state.motionHandler = motionPulse;
  window.addEventListener('devicemotion', state.motionHandler);
  els.musicToggle.textContent = '■ Stop listening';
  els.motionStatus.textContent = 'Listening live';
  els.motionStatus.className = 'status-pill live';
  els.motionHelp.textContent = 'Move with the train — rail movement now drives the beat.';
  setTimeout(() => {
    if (state.audio && !state.lastMotionEvent) {
      els.motionStatus.textContent = 'Audio on · no sensor data';
      els.motionStatus.className = 'status-pill error';
      els.motionHelp.textContent = location.protocol !== 'https:' && location.hostname !== 'localhost'
        ? 'Motion sensing needs HTTPS. The ambient audio is still playing.'
        : 'No motion events received. Check browser motion permissions; ambient audio is still playing.';
    }
  }, 3500);
}

async function composeWithAI() {
  if (!state.beatIntervals?.length) {
    els.motionHelp.textContent = 'Start listening and capture a few train beats first.';
    return;
  }
  els.aiCompose.disabled = true;
  els.aiCompose.textContent = 'Composing from your ride…';
  const samples = state.motionSamples || [];
  const payload = {
    station: state.nearest?.station || 'Kochi Metro',
    beatIntervals: state.beatIntervals.map(Math.round),
    averageMotion: samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0,
    peakMotion: samples.length ? Math.max(...samples) : 0,
  };
  try {
    let data;
    try {
      const response = await fetch('/api/compose-rhythm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('Local composer unavailable');
      data = await response.json();
    } catch {
      const result = await supabase.functions.invoke('compose-rhythm', { body: payload });
      if (result.error) throw result.error;
      data = result.data;
    }
    state.composition = data;
    state.audio?.oscillators?.forEach((oscillator, index) => {
      oscillator.type = data.waveforms[index] || 'sine';
      oscillator.frequency.setTargetAtTime(data.rootHz * (data.intervals[index] || 1), state.audio.context.currentTime, 0.7);
    });
    els.motionHelp.textContent = `AI composition ready: ${data.label}. It still follows your live train beats.`;
  } catch (error) {
    console.warn('AI composition failed', error);
    els.motionHelp.textContent = 'AI composer is not deployed yet. Follow the README setup, then retry.';
  } finally {
    els.aiCompose.disabled = false;
    els.aiCompose.textContent = '✦ Recompose from this ride';
  }
}

function switchView(target) {
  document.querySelectorAll('.app-view').forEach((view) => {
    const active = view.dataset.view === target;
    view.hidden = !active;
    view.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-btn').forEach((button) => {
    const active = button.dataset.target === target;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindEvents() {
  els.locateBtn.addEventListener('click', toggleLocation);
  els.locationToggle.addEventListener('click', toggleLocation);
  els.routeBtn.addEventListener('click', handleRoute);
  els.langSelect.addEventListener('change', () => { state.language = els.langSelect.value; if (state.nearest) announce(state.nearest, true); });
  els.muteToggle.addEventListener('click', () => {
    state.voiceMuted = !state.voiceMuted;
    if (state.voiceMuted) speechSynthesis.cancel();
    els.muteToggle.textContent = state.voiceMuted ? '🔇 Unmute voice' : '🔊 Mute voice';
    els.muteToggle.setAttribute('aria-pressed', String(state.voiceMuted));
  });
  els.musicToggle.addEventListener('click', toggleMusic);
  els.aiCompose.addEventListener('click', composeWithAI);
  document.querySelectorAll('.crowd-btn').forEach((button) => button.addEventListener('click', () => reportCrowd(Number(button.dataset.level))));
  els.crowdThreshold.addEventListener('change', refreshCrowd);
  document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.target)));
}

async function init() {
  try {
    await loadStations();
    renderLine();
  } catch (error) {
    els.locationStatus.textContent = location.protocol === 'file:' ? 'Use a local static server' : 'Station data unavailable';
    console.error(error);
    return;
  }
  bindEvents();
  try {
    state.crowdReports = JSON.parse(localStorage.getItem('metro-saathi-reports') || '[]');
  } catch {
    state.crowdReports = [];
  }
  state.crowdReports.push(...await seedCrowdDemo(isSupabaseConfigured));
  subscribeCrowd();
  if ('speechSynthesis' in window) {
    speechSynthesis.addEventListener('voiceschanged', () => {
      if (state.nearest && !state.voiceMuted) announce(state.nearest, true);
    });
  }
  startLocation();
}

init();
