/**
 * routing.js — Metro Saathi live routing helper
 *
 * Usage:
 *   1. Load kochi_metro_stations.json alongside this file.
 *   2. Call findNearestStation(lat, lng) to detect which metro station the
 *      rider is closest to right now.
 *   3. Call getLiveRoute(originLat, originLng, destLat, destLng) to fetch a
 *      real walking/driving route ONLY for the one attraction/hospital you
 *      are currently displaying — not all 25 in advance.
 *
 * Why OSRM: it's a free, no-API-key routing engine, so it won't break on
 * stage if you haven't set up a Google Maps API key in time. Swap the
 * ROUTE_PROVIDER flag to 'google' if you do have a key and want richer data.
 */

const ROUTE_PROVIDER = "osrm"; // "osrm" | "google"
const GOOGLE_MAPS_API_KEY = ""; // fill in only if ROUTE_PROVIDER = "google"

// ---- 1. Find nearest station from current GPS position ----
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestStation(lat, lng, stations) {
  let nearest = null;
  let minDist = Infinity;
  for (const s of stations) {
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d < minDist) {
      minDist = d;
      nearest = s;
    }
  }
  return { station: nearest, distanceKm: minDist };
}

// ---- 2. Live route fetch (call this only for the ONE place being shown) ----
async function getLiveRoute(originLat, originLng, destLat, destLng, mode = "walking") {
  try {
    if (ROUTE_PROVIDER === "osrm") {
      const profile = mode === "driving" ? "driving" : "foot";
      const url = `https://router.project-osrm.org/route/v1/${profile}/${originLng},${originLat};${destLng},${destLat}?overview=false`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.routes && data.routes.length) {
        const route = data.routes[0];
        return {
          distanceKm: (route.distance / 1000).toFixed(2),
          durationMin: Math.round(route.duration / 60),
          source: "osrm-live",
        };
      }
      throw new Error("No route found");
    }

    if (ROUTE_PROVIDER === "google") {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${originLat},${originLng}&destination=${destLat},${destLng}&mode=${mode}&key=${GOOGLE_MAPS_API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const leg = data.routes?.[0]?.legs?.[0];
      if (leg) {
        return {
          distanceKm: (leg.distance.value / 1000).toFixed(2),
          durationMin: Math.round(leg.duration.value / 60),
          source: "google-live",
        };
      }
      throw new Error("No route found");
    }
  } catch (err) {
    // Fallback: no network / API failure — use the pre-baked JSON estimate
    console.warn("Live routing failed, falling back to static estimate:", err);
    return null;
  }
}

// ---- 3. Fallback: build a Google Maps deep link (works even if fetch fails) ----
function mapsDeepLink(destLat, destLng, mode = "walking") {
  return `https://www.google.com/maps/dir/?api=1&destination=${destLat},${destLng}&travelmode=${mode}`;
}

// ---- Example usage ----
// const { station, distanceKm } = findNearestStation(userLat, userLng, stationsData.stations);
// const route = await getLiveRoute(userLat, userLng, hospitalLat, hospitalLng, "walking");
// if (!route) { showFallbackLink(mapsDeepLink(hospitalLat, hospitalLng)); }
// else { showRoute(`${route.distanceKm} km · ${route.durationMin} min`); }

export { findNearestStation, getLiveRoute, mapsDeepLink, haversineKm };
