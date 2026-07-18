import { findNearestStation, getLiveRoute, mapsDeepLink } from './routing.js';
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
    || voices.find((item) => item.lang.toLowerCase() === 'en-in');
  const utterance = new SpeechSynthesisUtterance(announcement(station));
  utterance.lang = voice?.lang || language;
  if (voice) utterance.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(utterance);
}

function handlePosition(position) {
  const { latitude, longitude, accuracy } = position.coords;
  state.currentPosition = { latitude, longitude };
  const result = findNearestStation(latitude, longitude, stations);
  if (!result.station) return;
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
  }
}

function startLocation() {
  if (!navigator.geolocation) {
    els.locationStatus.textContent = 'GPS unavailable';
    return;
  }
  els.locationStatus.textContent = 'Finding you…';
  navigator.geolocation.watchPosition(handlePosition, (error) => {
    els.locationStatus.textContent = error.code === 1 ? 'Location permission needed' : 'GPS unavailable';
    els.locationStatus.className = 'status-pill error';
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
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
  els.crowdBadge.textContent = `${status.label} · ${reports.length} report${reports.length === 1 ? '' : 's'}`;
  els.crowdBadge.className = `crowd-badge ${status.tone}`;
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
  const osc = state.audio.context.createOscillator();
  const gain = state.audio.context.createGain();
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.exponentialRampToValueAtTime(70, now + 0.12);
  gain.gain.setValueAtTime(0.08, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
  osc.connect(gain).connect(state.audio.master);
  osc.start(now); osc.stop(now + 0.15);
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
  els.locateBtn.addEventListener('click', startLocation);
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
  startLocation();
}

init();
