import { findNearestStation, getLiveRoute, mapsDeepLink, haversineKm } from './routing.js';
import { supabase, isSupabaseConfigured } from './supabase-config.js';
import { seedCrowdDemo } from './seed.js';

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MAX_METRO_DISTANCE_KM = 5;
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
  welcomeScreen: $('welcome-screen'), welcomeVideo: $('welcome-video'), enterApp: $('enter-app'), appShell: $('app-shell'),
  locationStatus: $('location-status'), metroLine: $('metro-line'), stationName: $('station-name'),
  stationDistance: $('station-distance'), stationAttraction: $('station-attraction'), hospitalName: $('hospital-name'),
  hospitalTimes: $('hospital-times'), policeName: $('police-name'), policeTimes: $('police-times'),
  routeOutput: $('route-output'), crowdBadge: $('crowd-badge'),
  crowdMessage: $('crowd-message'), langSelect: $('lang-select'), muteToggle: $('mute-toggle'),
  musicToggle: $('music-toggle'), locateBtn: $('locate-btn'), motionStatus: $('motion-status'),
  motionIntensity: $('motion-intensity'), beatCount: $('beat-count'), beatTempo: $('beat-tempo'),
  rhythmOrb: $('rhythm-orb'), motionHelp: $('motion-help'), rhythmStation: $('rhythm-station'),
  rhythmDistance: $('rhythm-distance'), crowdStation: $('crowd-station'), guideStation: $('guide-station'),
  aiCompose: $('ai-compose'),
  locationToggle: $('location-toggle'), crowdThreshold: $('crowd-threshold'), crowdAlert: $('crowd-alert'),
  motionSensitivity: $('motion-sensitivity'), testBeat: $('test-beat'),
  manualStation: $('manual-station'),
  trainId: $('train-id'),
  voiceStatus: $('voice-status'), voiceVisualizer: $('voice-visualizer'),
  demoToggle: $('demo-toggle'), demoExit: $('demo-exit'), demoStatus: $('demo-status'),
  demoDirection: $('demo-direction'), demoSpeed: $('demo-speed'),
};

function playMetroDoorSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return Promise.resolve();
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.setValueAtTime(0.001, context.currentTime);
  master.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.035);
  master.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 1.05);
  master.connect(context.destination);

  [0, 0.2].forEach((offset, index) => {
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(index ? 880 : 659.25, context.currentTime + offset);
    gain.gain.setValueAtTime(0.001, context.currentTime + offset);
    gain.gain.exponentialRampToValueAtTime(0.45, context.currentTime + offset + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + offset + 0.19);
    tone.connect(gain).connect(master);
    tone.start(context.currentTime + offset);
    tone.stop(context.currentTime + offset + 0.21);
  });

  const noiseBuffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.58), context.sampleRate);
  const noise = noiseBuffer.getChannelData(0);
  for (let index = 0; index < noise.length; index += 1) noise[index] = (Math.random() * 2 - 1) * (1 - index / noise.length);
  const air = context.createBufferSource();
  const airFilter = context.createBiquadFilter();
  const airGain = context.createGain();
  air.buffer = noiseBuffer;
  airFilter.type = 'bandpass';
  airFilter.frequency.value = 1450;
  airFilter.Q.value = 0.65;
  airGain.gain.setValueAtTime(0.001, context.currentTime + 0.38);
  airGain.gain.exponentialRampToValueAtTime(0.34, context.currentTime + 0.45);
  airGain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.95);
  air.connect(airFilter).connect(airGain).connect(master);
  air.start(context.currentTime + 0.38);
  return new Promise((resolve) => window.setTimeout(() => { context.close(); resolve(); }, 1080));
}

async function enterMetroSaathi() {
  if (!els.welcomeScreen) return;
  els.enterApp.disabled = true;
  els.welcomeScreen.classList.add('door-opening');
  // Request GPS directly from the user's tap, before the door animation ends.
  startLocation();
  await playMetroDoorSound();
  els.welcomeScreen.classList.add('leaving');
  document.body.classList.remove('splash-active');
  els.appShell?.removeAttribute('inert');
  window.setTimeout(() => {
    if (els.welcomeVideo) els.welcomeVideo.src = 'about:blank';
    els.welcomeScreen.remove();
  }, 560);
}

async function loadStations() {
  const response = await fetch('./kochi_metro_stations.json');
  if (!response.ok) throw new Error(`Station data returned ${response.status}`);
  const payload = await response.json();
  stations = (payload.stations || payload).slice().sort((a, b) => a.order - b.order);
  stations.forEach((station, index) => els.manualStation.add(new Option(station.station, String(index))));
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
  const distanceLabel = Number.isFinite(distanceKm) ? `${distanceKm.toFixed(2)} km from your position` : 'Station selected manually';
  els.stationDistance.textContent = distanceLabel;
  els.stationAttraction.textContent = station.attraction;
  els.hospitalName.textContent = station.hospital;
  els.hospitalTimes.textContent = `Walk ${station.hospital_walk_min} min · Auto ${station.hospital_auto_min} min`;
  els.policeName.textContent = station.police;
  els.policeTimes.textContent = `Walk ${station.police_walk_min} min · Auto ${station.police_auto_min} min`;
  els.routeOutput.textContent = 'Choose attraction, hospital, or police directions.';
  els.rhythmStation.textContent = station.station;
  els.rhythmDistance.textContent = Number.isFinite(distanceKm) ? `${distanceKm.toFixed(2)} km from your live position` : 'Manual station confirmation';
  els.crowdStation.textContent = station.station;
  els.guideStation.textContent = station.station;
  renderLine();
  announce(station, true);
  refreshCrowd();
}

function announcement(station) {
  const hospital = station.hospital.replace(/\s*-\s*~.*$/, '').split('/')[0].trim();
  const police = station.police.replace(/\s*-\s*~.*$/, '').split('/')[0].trim();
  const en = `Next stop, ${station.station}. For medical help, ${hospital} is about ${station.hospital_walk_min} minutes away. For police assistance, ${police} is nearby.`;
  if (state.language === 'ml') return `അടുത്ത സ്റ്റേഷൻ, ${station.station}. ചികിത്സാ സഹായത്തിന് ${hospital}, ഏകദേശം ${station.hospital_walk_min} മിനിറ്റ് ദൂരം. പോലീസ് സഹായത്തിന് ${police} സമീപത്തുണ്ട്.`;
  if (state.language === 'hi') return `अगला स्टेशन, ${station.station}। चिकित्सा सहायता के लिए ${hospital}, लगभग ${station.hospital_walk_min} मिनट दूर है। पुलिस सहायता के लिए ${police} पास में है।`;
  return en;
}

function announceWithBrowser(station, force = false) {
  return new Promise((resolve) => {
  if (state.voiceMuted || !('speechSynthesis' in window) || (!force && station.station === state.lastSpoken)) { resolve(); return; }
  state.lastSpoken = station.station;
  const language = { en: 'en-IN', ml: 'ml-IN', hi: 'hi-IN' }[state.language];
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((item) => item.lang.toLowerCase() === language.toLowerCase())
    || voices.find((item) => item.lang.toLowerCase().startsWith(state.language))
    || voices.find((item) => item.lang.toLowerCase() === 'en-in');
  const utterance = new SpeechSynthesisUtterance(announcement(station));
  utterance.lang = voice?.lang || language;
  if (voice) utterance.voice = voice;
  const finishBrowserVoice = () => { els.voiceVisualizer?.classList.remove('speaking'); resolve(); };
  utterance.addEventListener('end', finishBrowserVoice, { once: true });
  utterance.addEventListener('error', finishBrowserVoice, { once: true });
  speechSynthesis.cancel();
  els.voiceVisualizer?.classList.add('speaking');
  speechSynthesis.speak(utterance);
  });
}

function finishAnnouncement() {
  state.voiceBusy = false;
  if (state.voiceMuted || !state.pendingAnnouncement) return;
  const pending = state.pendingAnnouncement;
  state.pendingAnnouncement = null;
  announce(pending.station, true);
}

function cancelAnnouncement() {
  state.voiceRequestId = (state.voiceRequestId || 0) + 1;
  state.voiceAbortController?.abort();
  state.voiceAbortController = null;
  window.speechSynthesis?.cancel();
  if (state.voiceAudio) {
    state.voiceAudio.pause();
    URL.revokeObjectURL(state.voiceAudio.src);
    state.voiceAudio = null;
  }
  state.voiceBusy = false;
  state.pendingAnnouncement = null;
  els.voiceVisualizer?.classList.remove('speaking');
  if (state.audio) state.audio.master.gain.setTargetAtTime(0.13, state.audio.context.currentTime, 0.12);
}

async function announce(station, force = false, replaceCurrent = false) {
  if (state.voiceMuted || (!force && station.station === state.lastSpoken)) return;
  if (replaceCurrent && state.voiceBusy) cancelAnnouncement();
  if (state.voiceBusy) {
    state.pendingAnnouncement = { station };
    els.voiceStatus.textContent = `Current announcement will finish · ${station.station} queued next`;
    return;
  }
  state.voiceBusy = true;
  state.lastSpoken = station.station;
  state.voiceRequestId = (state.voiceRequestId || 0) + 1;
  const requestId = state.voiceRequestId;
  state.voiceAbortController?.abort();
  state.voiceAbortController = new AbortController();
  window.speechSynthesis?.cancel();
  if (state.voiceAudio) {
    state.voiceAudio.pause();
    URL.revokeObjectURL(state.voiceAudio.src);
    state.voiceAudio = null;
    if (state.audio) state.audio.master.gain.setTargetAtTime(0.13, state.audio.context.currentTime, 0.08);
  }
  const voiceProfile = { ml: 'Malayalam · Marin', hi: 'Hindi · Coral', en: 'English · Cedar' }[state.language];
  els.voiceStatus.textContent = `Preparing ${voiceProfile} voice…`;
  try {
    const response = await fetch('/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: announcement(station), language: state.language }),
      signal: state.voiceAbortController.signal,
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem.error || `Speech returned ${response.status}`);
    }
    const voiceEngine = response.headers.get('X-Voice-Engine');
    const blob = await response.blob();
    if (requestId !== state.voiceRequestId || state.voiceMuted) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.voiceAudio = audio;
    if (state.audio) state.audio.master.gain.setTargetAtTime(0.025, state.audio.context.currentTime, 0.08);
    let restored = false;
    const restoreMusic = () => {
      if (restored) return;
      restored = true;
      if (state.audio) state.audio.master.gain.setTargetAtTime(0.13, state.audio.context.currentTime, 0.25);
      URL.revokeObjectURL(url);
      if (state.voiceAudio === audio) state.voiceAudio = null;
      els.voiceVisualizer?.classList.remove('speaking');
      finishAnnouncement();
    };
    audio.addEventListener('ended', restoreMusic, { once: true });
    audio.addEventListener('error', restoreMusic, { once: true });
    await audio.play();
    els.voiceVisualizer?.classList.add('speaking');
    if (requestId !== state.voiceRequestId) { audio.pause(); restoreMusic(); return; }
    els.voiceStatus.textContent = voiceEngine === 'gpt-audio-1.5'
      ? `Expressive AI voice · ${voiceProfile}`
      : `Standard AI voice fallback · ${voiceProfile}`;
  } catch (error) {
    if (requestId !== state.voiceRequestId) return;
    if (error.name === 'AbortError') { state.voiceBusy = false; return; }
    console.warn('Natural voice unavailable', error);
    if (state.voiceAudio) {
      state.voiceAudio.pause();
      URL.revokeObjectURL(state.voiceAudio.src);
      state.voiceAudio = null;
    }
    if (state.audio) state.audio.master.gain.setTargetAtTime(0.13, state.audio.context.currentTime, 0.15);
    els.voiceStatus.textContent = 'Expressive AI voice unavailable · browser robot voice disabled';
    finishAnnouncement();
  }
}

function handlePosition(position) {
  if (position.timestamp && position.timestamp < (state.lastPositionTimestamp || 0)) return;
  state.lastPositionTimestamp = position.timestamp || Date.now();
  const { latitude, longitude, accuracy } = position.coords;
  if (![latitude, longitude, accuracy].every(Number.isFinite)) {
    els.locationStatus.textContent = 'Invalid location reading · retrying';
    els.locationStatus.className = 'status-pill error';
    return;
  }
  state.currentPosition = { latitude, longitude };
  els.locationStatus.title = `GPS ${latitude.toFixed(5)}, ${longitude.toFixed(5)} · accuracy ±${Math.round(accuracy)} m`;
  const rawNearest = findNearestStation(latitude, longitude, stations);
  if (rawNearest.distanceKm > MAX_METRO_DISTANCE_KM) {
    state.stationIndex = null;
    state.lineProgress = null;
    state.nearest = null;
    els.locationStatus.textContent = 'Outside Kochi Metro area';
    els.locationStatus.className = 'status-pill error';
    els.stationName.textContent = `Nearest: ${rawNearest.station.station}`;
    els.stationDistance.textContent = `${rawNearest.distanceKm.toFixed(1)} km away · Chrome location is outside the metro corridor`;
    els.rhythmStation.textContent = `Nearest metro: ${rawNearest.station.station}`;
    els.rhythmDistance.textContent = `${rawNearest.distanceKm.toFixed(1)} km from Chrome location · not confirmed as your station`;
    els.crowdStation.textContent = 'Select a station';
    els.guideStation.textContent = 'Select a station';
    els.routeOutput.textContent = `You appear outside the metro area. ${rawNearest.station.station} is the nearest station.`;
    renderLine();
    return;
  }
  const rawIndex = stations.indexOf(rawNearest.station);
  if (state.stationIndex == null) {
    state.stationIndex = rawIndex;
  } else if (rawIndex !== state.stationIndex) {
    if (state.gpsCandidateIndex === rawIndex) state.gpsCandidateCount = (state.gpsCandidateCount || 0) + 1;
    else { state.gpsCandidateIndex = rawIndex; state.gpsCandidateCount = 1; }
    if (state.gpsCandidateCount >= 2) {
      state.stationIndex = rawIndex;
      state.gpsCandidateIndex = null;
      state.gpsCandidateCount = 0;
    }
  } else {
    state.gpsCandidateIndex = null;
    state.gpsCandidateCount = 0;
  }
  state.lineProgress = state.lineProgress == null ? state.stationIndex : state.lineProgress * 0.55 + state.stationIndex * 0.45;
  const trackedStation = stations[state.stationIndex];
  const result = { station: trackedStation, distanceKm: haversineKm(latitude, longitude, trackedStation.lat, trackedStation.lng) };
  els.locationStatus.textContent = `${accuracy > 180 ? 'Chrome approximate' : 'Chrome GPS live'} · ±${Math.round(accuracy)} m`;
  els.locationStatus.className = `status-pill ${accuracy > 180 ? 'error' : 'live'}`;
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
  if (!window.isSecureContext) {
    els.locationStatus.textContent = 'GPS requires HTTPS or localhost';
    els.locationStatus.className = 'status-pill error';
    els.locationStatus.title = 'Open this app on https:// or on localhost. Browsers block GPS on ordinary HTTP network addresses.';
    return;
  }
  if (!navigator.geolocation) {
    els.locationStatus.textContent = 'GPS unavailable';
    return;
  }
  els.locationStatus.textContent = 'Finding you…';
  const locationOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };
  const handleLocationError = (error) => {
    if (state.currentPosition && error.code !== 1) return;
    els.locationStatus.textContent = error.code === 1 ? 'Allow location in Chrome' : error.code === 3 ? 'Chrome GPS timed out · retrying' : 'Chrome GPS unavailable';
    els.locationStatus.className = 'status-pill error';
  };
  navigator.geolocation.getCurrentPosition(handlePosition, handleLocationError, locationOptions);
  state.watchId = navigator.geolocation.watchPosition(handlePosition, handleLocationError, locationOptions);
  els.locationToggle.textContent = '■ Stop location';
  els.locateBtn.textContent = '■ Stop location';
}

function stopLocation() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.stationIndex = null;
  state.lineProgress = null;
  state.gpsCandidateIndex = null;
  state.gpsCandidateCount = 0;
  state.reacquireIndex = null;
  state.reacquireCount = 0;
  els.locationStatus.textContent = 'GPS off';
  els.locationStatus.className = 'status-pill';
  els.locationToggle.textContent = '⌖ Start location';
  els.locateBtn.textContent = '⌖ Start location';
  window.speechSynthesis?.cancel();
}

function toggleLocation() {
  if (state.watchId == null) startLocation(); else stopLocation();
}

function routePlace(station, kind) {
  const value = station[kind] || '';
  return value.replace(/\s*-\s*~.*$/, '').split('/')[0].split(' - ')[0].trim();
}

async function handleRoute(kind, button) {
  if (!state.nearest || !state.currentPosition) {
    els.routeOutput.textContent = 'Enable location first.';
    return;
  }
  const station = state.nearest;
  button.disabled = true;
  const label = kind === 'police' ? 'police station' : kind;
  els.routeOutput.textContent = `Finding a live route to the ${label}…`;
  try {
    // The supplied station file currently has place names but no destination coordinates. Use a Maps place query;
    // if future data adds coordinates, the live OSRM route is used automatically.
    const latitude = station[`${kind}_lat`];
    const longitude = station[`${kind}_lng`];
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const route = await getLiveRoute(state.currentPosition.latitude, state.currentPosition.longitude, latitude, longitude, 'walking');
      if (route) {
        els.routeOutput.textContent = `${route.distanceKm} km · ${route.durationMin} min walk to ${routePlace(station, kind)}`;
        return;
      }
      showMapLink(mapsDeepLink(latitude, longitude, 'walking'), label);
      return;
    }
    const origin = `${state.currentPosition.latitude},${state.currentPosition.longitude}`;
    const destination = encodeURIComponent(`${routePlace(station, kind)}, near ${station.station} Metro Station, Kochi, Kerala`);
    showMapLink(`https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=walking`, label);
  } finally {
    button.disabled = false;
  }
}

function showMapLink(href, label = 'destination') {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `Open ${label} route in Google Maps ↗`;
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
  if (shouldAlert) els.crowdAlert.textContent = `⚠ ${state.trainId} is crowded near ${state.nearest?.station || 'your station'} — ${status.label.toLowerCase()}.`;
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
  if (state.demoMode) {
    paintCrowd(state.demoReports || []);
    els.crowdMessage.textContent = `Demo crowd feed · ${state.trainId}`;
    return;
  }
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
  if (state.demoMode) {
    state.demoReports = [...(state.demoReports || []), row];
    els.crowdMessage.textContent = 'Demo report added to this simulated train.';
    paintCrowd(state.demoReports);
    return;
  }
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

function motionPulse(event, forcedMagnitude = null) {
  if (!state.audio) return;
  let magnitude = forcedMagnitude;
  if (magnitude == null) {
    const a = event.acceleration || event.accelerationIncludingGravity;
    if (!a) return;
    const vector = [a.x || 0, a.y || 0, a.z || 0];
    state.lastMotionEvent = performance.now();
    els.motionStatus.textContent = 'Listening live';
    els.motionStatus.className = 'status-pill live';
    if (!state.previousAcceleration) {
      state.previousAcceleration = vector;
      return;
    }
    magnitude = Math.hypot(
      vector[0] - state.previousAcceleration[0],
      vector[1] - state.previousAcceleration[1],
      vector[2] - state.previousAcceleration[2],
    );
    state.previousAcceleration = vector;
    state.motionNoise = state.motionNoise == null ? magnitude : state.motionNoise * 0.96 + magnitude * 0.04;
  }
  const visualIntensity = Math.min(10, magnitude * 9);
  state.motionSamples = [...(state.motionSamples || []), visualIntensity].slice(-240);
  els.motionIntensity.textContent = visualIntensity.toFixed(1);
  els.rhythmOrb.style.setProperty('--motion', `${1 + visualIntensity / 28}`);
  state.audio.master.gain.setTargetAtTime(0.11 + Math.min(magnitude, 5) * 0.018, state.audio.context.currentTime, 0.08);
  const sensitivity = Number(els.motionSensitivity.value);
  const manualThreshold = Math.max(0.035, 0.55 - sensitivity * 0.052);
  const adaptiveThreshold = Math.max(manualThreshold, (state.motionNoise || 0) * 1.3);
  if (forcedMagnitude == null && (magnitude < adaptiveThreshold || performance.now() - (state.lastPulse || 0) < 140)) return;
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
  if (state.beatCount >= 8 && !state.aiAutoRequested && state.beatIntervals?.length >= 4) {
    state.aiAutoRequested = true;
    els.motionHelp.textContent = 'Enough beats captured — AI is composing from this train rhythm…';
    composeWithAI();
  }
  if (state.beatCount >= 8 && !state.capturedRhythmActive && state.beatIntervals?.length >= 4) {
    startCapturedRhythm();
  }
}

function startCapturedRhythm() {
  state.rhythmPattern = state.beatIntervals.slice(-8).map((interval) => Math.max(180, Math.min(1100, interval)));
  state.capturedRhythmActive = true;
  state.rhythmStep = 0;
  const playStep = () => {
    if (!state.audio || !state.capturedRhythmActive) return;
    const { context, master } = state.audio;
    const recipe = state.composition || { rootHz: 73.42, intervals: [1, 1.5], waveforms: ['triangle', 'sine'] };
    const step = state.rhythmStep % state.rhythmPattern.length;
    const interval = recipe.intervals[step % recipe.intervals.length] || 1;
    const now = context.currentTime;
    const note = context.createOscillator();
    const noteGain = context.createGain();
    note.type = recipe.waveforms[step % recipe.waveforms.length] || 'triangle';
    note.frequency.setValueAtTime(recipe.rootHz * interval * (step % 4 === 0 ? 2 : 1), now);
    noteGain.gain.setValueAtTime(0.22, now);
    noteGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    note.connect(noteGain).connect(master);
    note.start(now); note.stop(now + 0.17);
    state.rhythmStep += 1;
    state.rhythmLoopTimer = setTimeout(playStep, state.rhythmPattern[step]);
  };
  playStep();
  els.motionHelp.textContent = `Looping your captured ${state.rhythmPattern.length}-beat train rhythm. AI harmony is being applied.`;
}

function stopCapturedRhythm() {
  clearTimeout(state.rhythmLoopTimer);
  state.rhythmLoopTimer = null;
  state.capturedRhythmActive = false;
}

async function startMicrophoneRhythm() {
  state.microphoneError = null;
  if (!navigator.mediaDevices?.getUserMedia || !state.audio) {
    state.microphoneError = 'unavailable';
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!state.audio) { stream.getTracks().forEach((track) => track.stop()); return false; }
    const source = state.audio.context.createMediaStreamSource(stream);
    const analyser = state.audio.context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser); // Intentionally not connected to speakers: prevents feedback.
    const samples = new Float32Array(analyser.fftSize);
    state.microphone = { stream, source, analyser };
    const listen = () => {
      if (!state.audio || !state.microphone) return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      state.micBaseline = state.micBaseline == null ? rms : state.micBaseline * 0.965 + rms * 0.035;
      const transient = Math.max(0, rms - state.micBaseline);
      const sensitivity = Number(els.motionSensitivity.value);
      const threshold = Math.max(0.006, 0.038 - sensitivity * 0.0032);
      const intensity = Math.min(10, transient * 260);
      els.motionIntensity.textContent = intensity.toFixed(1);
      els.rhythmOrb.style.setProperty('--motion', `${1 + intensity / 28}`);
      if (transient > threshold && performance.now() - (state.lastPulse || 0) > 160) {
        motionPulse({}, Math.min(2.5, 0.55 + transient * 28));
      }
      state.microphoneFrame = requestAnimationFrame(listen);
    };
    listen();
    els.motionStatus.textContent = 'Microphone listening';
    els.motionStatus.className = 'status-pill live';
    return true;
  } catch (error) {
    console.warn('Microphone rhythm unavailable', error);
    state.microphoneError = error.name === 'NotAllowedError' ? 'denied' : error.name || 'unavailable';
    return false;
  }
}

function stopMicrophoneRhythm() {
  if (state.microphoneFrame) cancelAnimationFrame(state.microphoneFrame);
  state.microphone?.stream.getTracks().forEach((track) => track.stop());
  state.microphone?.source.disconnect();
  state.microphone = null;
  state.microphoneFrame = null;
  state.micBaseline = null;
}

async function toggleMusic(options = {}) {
  const demoOnly = options?.demo === true;
  if (state.audio) {
    window.removeEventListener('devicemotion', state.motionHandler);
    stopMicrophoneRhythm();
    stopCapturedRhythm();
    await state.audio.context.close();
    state.audio = null;
    state.previousAcceleration = null;
    state.motionNoise = null;
    els.musicToggle.textContent = '▶ Start listening to the train';
    els.motionStatus.textContent = 'Sensor off';
    els.motionStatus.className = 'status-pill';
    els.motionHelp.textContent = 'Rhythm stopped. Tap to listen again.';
    els.motionIntensity.textContent = '0.0';
    return;
  }
  state.motionPermissionDenied = false;
  if (!demoOnly && typeof window.DeviceMotionEvent?.requestPermission === 'function') {
    try {
      state.motionPermissionDenied = await window.DeviceMotionEvent.requestPermission() !== 'granted';
    } catch {
      state.motionPermissionDenied = true;
    }
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  state.lastMotionEvent = null;
  state.previousAcceleration = null;
  state.motionNoise = null;
  const master = context.createGain(); master.gain.value = 0.13; master.connect(context.destination);
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
  let microphoneActive = false;
  if (!demoOnly) {
    state.motionHandler = motionPulse;
    window.addEventListener('devicemotion', state.motionHandler);
    microphoneActive = await startMicrophoneRhythm();
  }
  els.musicToggle.textContent = '■ Stop listening';
  els.motionStatus.textContent = demoOnly ? 'Demo rhythm live' : microphoneActive ? 'Microphone listening' : 'Audio on';
  els.motionStatus.className = 'status-pill live';
  els.motionHelp.textContent = demoOnly
    ? 'Demo rail beats are now building a musical loop.'
    : microphoneActive
      ? 'Microphone is listening for rail clicks and carriage vibration. Motion is used too when available.'
      : 'Listening for device movement. Microphone rhythm input is not available.';
  setTimeout(() => {
    if (state.audio && !state.lastMotionEvent && !state.microphone) {
      els.motionStatus.textContent = 'Ambient audio only';
      els.motionStatus.className = 'status-pill error';
      if (!window.isSecureContext) {
        els.motionHelp.textContent = 'Sensors require HTTPS or localhost. The ambient layer is still playing.';
      } else if (state.microphoneError === 'denied') {
        els.motionHelp.textContent = 'Microphone permission is blocked. Allow it in the address bar, then stop and restart listening.';
      } else if (state.motionPermissionDenied) {
        els.motionHelp.textContent = 'Motion permission was denied and microphone input is unavailable. Enable either permission or use TAP BEAT.';
      } else {
        els.motionHelp.textContent = 'This laptop has no motion sensor and no microphone input was available. Allow microphone access or use TAP BEAT.';
      }
    }
  }, 3500);
}

function buildDemoCrowd(stationIndex) {
  const base = stationIndex % 5 === 2 ? 3 : stationIndex % 3 === 0 ? 2 : 1;
  state.demoReports = Array.from({ length: 6 }, (_, index) => ({
    station: stations[stationIndex].station,
    level: Math.max(1, Math.min(3, base + (index % 4 === 0 ? 1 : 0))),
    created_at: new Date(Date.now() - index * 70_000).toISOString(),
  }));
}

function scheduleDemoBeat() {
  clearTimeout(state.demoBeatTimer);
  if (!state.demoRunning) return;
  const speed = Number(els.demoSpeed.value);
  const interval = Math.max(190, (430 + Math.random() * 260) / Math.sqrt(speed));
  state.demoBeatTimer = setTimeout(() => {
    if (state.audio) motionPulse({}, 0.7 + Math.random() * 1.25);
    scheduleDemoBeat();
  }, interval);
}

async function startDemoRide() {
  if (state.demoRunning) {
    state.demoRunning = false;
    clearInterval(state.demoJourneyTimer);
    clearTimeout(state.demoBeatTimer);
    els.demoToggle.textContent = '▶ Resume demo ride';
    els.demoStatus.textContent = 'Paused';
    return;
  }
  if (!state.demoMode) {
    if (state.watchId != null) stopLocation();
    state.demoMode = true;
    state.liveTrainId = state.trainId;
    state.trainId = 'DEMO-TRAIN-001';
    els.trainId.textContent = `Demo · ${state.trainId}`;
    const selected = els.manualStation.value === '' ? 0 : Number(els.manualStation.value);
    state.demoProgress = selected;
    state.stationIndex = selected;
    state.lineProgress = selected;
    state.nearest = stations[selected];
    buildDemoCrowd(selected);
    updateStationCard(state.nearest, Number.NaN);
    els.demoExit.hidden = false;
  }
  if (!state.audio) {
    state.demoStartedAudio = true;
    await toggleMusic({ demo: true });
  }
  state.demoRunning = true;
  els.demoToggle.textContent = 'Ⅱ Pause demo ride';
  els.demoStatus.textContent = 'Running';
  els.locationStatus.textContent = 'Demo simulation';
  els.locationStatus.className = 'status-pill live';
  scheduleDemoBeat();
  clearInterval(state.demoJourneyTimer);
  state.demoJourneyTimer = setInterval(() => {
    if (!state.demoRunning) return;
    const direction = Number(els.demoDirection.value);
    const speed = Number(els.demoSpeed.value);
    state.demoProgress += direction * 0.018 * speed;
    if (state.demoProgress >= stations.length - 1 || state.demoProgress <= 0) {
      state.demoProgress = Math.max(0, Math.min(stations.length - 1, state.demoProgress));
      els.demoDirection.value = String(direction * -1);
    }
    state.lineProgress = state.demoProgress;
    const nextIndex = Math.round(state.demoProgress);
    if (nextIndex !== state.stationIndex) {
      state.stationIndex = nextIndex;
      state.nearest = stations[nextIndex];
      buildDemoCrowd(nextIndex);
      updateStationCard(state.nearest, Number.NaN);
    } else {
      els.stationDistance.textContent = 'Demo train moving between stations';
      els.rhythmDistance.textContent = 'Simulated journey in progress';
      renderLine();
    }
  }, 350);
}

async function exitDemoRide() {
  state.demoRunning = false;
  state.demoMode = false;
  clearInterval(state.demoJourneyTimer);
  clearTimeout(state.demoBeatTimer);
  state.demoJourneyTimer = null;
  state.demoBeatTimer = null;
  if (state.demoStartedAudio && state.audio) await toggleMusic({ demo: true });
  state.demoStartedAudio = false;
  state.stationIndex = null;
  state.lineProgress = null;
  state.nearest = null;
  state.trainId = state.liveTrainId || state.trainId;
  els.trainId.textContent = `Train · ${state.trainId}`;
  els.demoToggle.textContent = '▶ Start demo ride';
  els.demoStatus.textContent = 'Ready';
  els.demoExit.hidden = true;
  els.locationStatus.textContent = 'GPS off';
  els.locationStatus.className = 'status-pill';
  els.stationName.textContent = 'Start location or select a station';
  els.stationDistance.textContent = '';
  els.rhythmStation.textContent = 'No station confirmed';
  els.crowdStation.textContent = 'Select a station';
  els.crowdBadge.textContent = 'Waiting for station';
  els.crowdBadge.className = 'crowd-badge neutral';
  renderLine();
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
    trainId: state.trainId,
    station: state.nearest?.station || 'Kochi Metro',
    beatIntervals: state.beatIntervals.map(Math.round),
    averageMotion: samples.length ? samples.reduce((sum, value) => sum + value, 0) / samples.length : 0,
    peakMotion: samples.length ? Math.max(...samples) : 0,
  };
  try {
    let data;
    try {
      let localReached = false;
      const response = await fetch('/api/compose-rhythm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      localReached = true;
      if (!response.ok) {
        const problem = await response.json().catch(() => ({}));
        throw new Error(problem.error || `Composer returned ${response.status}`);
      }
      data = await response.json();
    } catch (localError) {
      if (localError.message !== 'Failed to fetch') throw localError;
      const result = await supabase.functions.invoke('compose-rhythm', { body: payload });
      if (result.error) throw result.error;
      data = result.data;
    }
    state.composition = data;
    state.audio?.oscillators?.forEach((oscillator, index) => {
      oscillator.type = data.waveforms[index] || 'sine';
      oscillator.frequency.setTargetAtTime(data.rootHz * (data.intervals[index] || 1), state.audio.context.currentTime, 0.7);
    });
    playCompositionPreview(data);
    els.motionHelp.textContent = `AI composition ready: ${data.label}. It still follows your live train beats.`;
  } catch (error) {
    console.warn('AI composition failed', error);
    els.motionHelp.textContent = `AI composer error: ${error.message || 'request failed'}`;
  } finally {
    els.aiCompose.disabled = false;
    els.aiCompose.textContent = '✦ Recompose from this ride';
  }
}

function playCompositionPreview(recipe) {
  if (!state.audio) return;
  const { context, master } = state.audio;
  recipe.intervals.forEach((interval, index) => {
    const start = context.currentTime + index * 0.18;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = recipe.waveforms[index] || 'sine';
    oscillator.frequency.value = recipe.rootHz * interval * 2;
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.exponentialRampToValueAtTime(0.32, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.42);
    oscillator.connect(gain).connect(master);
    oscillator.start(start); oscillator.stop(start + 0.45);
  });
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
    if (active) button.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindEvents() {
  els.locateBtn.addEventListener('click', toggleLocation);
  els.locationToggle.addEventListener('click', toggleLocation);
  document.querySelectorAll('.mini-route-btn').forEach((button) => button.addEventListener('click', () => handleRoute(button.dataset.routeKind, button)));
  els.langSelect.addEventListener('change', () => {
    state.language = els.langSelect.value;
    if (state.nearest) announce(state.nearest, true, true);
  });
  els.muteToggle.addEventListener('click', () => {
    state.voiceMuted = !state.voiceMuted;
    if (state.voiceMuted) speechSynthesis.cancel();
    if (state.voiceMuted) {
      state.voiceRequestId = (state.voiceRequestId || 0) + 1;
      state.voiceAbortController?.abort();
      state.voiceBusy = false;
      state.pendingAnnouncement = null;
      els.voiceVisualizer?.classList.remove('speaking');
    }
    if (state.voiceMuted && state.voiceAudio) {
      state.voiceAudio.pause();
      URL.revokeObjectURL(state.voiceAudio.src);
      state.voiceAudio = null;
      if (state.audio) state.audio.master.gain.setTargetAtTime(0.13, state.audio.context.currentTime, 0.2);
    }
    els.muteToggle.textContent = state.voiceMuted ? '🔇 Unmute voice' : '🔊 Mute voice';
    els.muteToggle.setAttribute('aria-pressed', String(state.voiceMuted));
  });
  els.musicToggle.addEventListener('click', toggleMusic);
  els.testBeat.addEventListener('click', async () => {
    if (!state.audio) await toggleMusic();
    if (state.audio) {
      motionPulse({}, 1.2);
      els.motionHelp.textContent = 'Test beat played. Live beats use the phone’s 3-axis motion sensor.';
    }
  });
  els.aiCompose.addEventListener('click', composeWithAI);
  els.demoToggle.addEventListener('click', startDemoRide);
  els.demoExit.addEventListener('click', exitDemoRide);
  document.querySelectorAll('.crowd-btn').forEach((button) => button.addEventListener('click', () => reportCrowd(Number(button.dataset.level))));
  els.crowdThreshold.addEventListener('change', refreshCrowd);
  els.manualStation.addEventListener('change', () => {
    if (els.manualStation.value === '') {
      state.stationIndex = null;
      els.locationStatus.textContent = 'Automatic GPS';
      startLocation();
      return;
    }
    state.stationIndex = Number(els.manualStation.value);
    state.lineProgress = state.stationIndex;
    state.nearest = stations[state.stationIndex];
    updateStationCard(state.nearest, Number.NaN);
    els.locationStatus.textContent = 'Station selected · GPS remains active';
    els.locationStatus.className = 'status-pill';
    startLocation();
  });
  document.querySelectorAll('.nav-btn').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.target)));
}

async function init() {
  els.enterApp?.addEventListener('click', enterMetroSaathi);
  const savedTrainId = sessionStorage.getItem('metro-saathi-train-id');
  state.trainId = savedTrainId || `DEMO-TRAIN-${String(Math.floor(100 + Math.random() * 900))}`;
  sessionStorage.setItem('metro-saathi-train-id', state.trainId);
  els.trainId.textContent = `Train · ${state.trainId}`;
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
}

init();
