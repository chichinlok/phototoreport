// Constants for HK1980 Grid System
const a = 6378388.0; // Semi-major axis (International 1924)
const f = 1 / 297.0; // Flattening (International 1924)
const b = a * (1 - f); // Semi-minor axis
const e2 = 2 * f - f * f; // First eccentricity squared
const e = Math.sqrt(e2); // First eccentricity
const ePrime2 = e2 / (1 - e2); // Second eccentricity squared

const m0 = 0.99990; // Scale factor at central meridian
const phi0Rad = 22.312133333 * (Math.PI / 180); // Latitude of origin (radians)
const lambda0Rad = 114.178555556 * (Math.PI / 180); // Longitude of origin (radians)
const N0 = 819069.80; // False Northing
const E0 = 836694.05; // False Easting

/**
 * Convert WGS84 Latitude and Longitude to HK1980 Grid Coordinates
 */
export const wgs84ToHK80 = (lat: number, lng: number): { northing: number; easting: number } => {
  // Standard offset values (approximate) to shift WGS84 to HK80 Geographic
  const latRad = (lat - 0.0015277778) * (Math.PI / 180); // shift ~5.5s South
  const lngRad = (lng + 0.0024444444) * (Math.PI / 180); // shift ~8.8s East

  // 2. Transverse Mercator Projection
  const nu = a / Math.sqrt(1 - e2 * Math.sin(latRad) * Math.sin(latRad));
  const rho = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(latRad) * Math.sin(latRad), 1.5);
  const psi = nu / rho;
  const t = Math.tan(latRad);
  const t2 = t * t;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  
  const deltaLambda = lngRad - lambda0Rad;
  const deltaLambda2 = deltaLambda * deltaLambda;
  const deltaLambda3 = deltaLambda2 * deltaLambda;
  const deltaLambda4 = deltaLambda3 * deltaLambda;
  const deltaLambda5 = deltaLambda4 * deltaLambda;

  // Meridian Arc Length (M)
  const A0 = 1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256;
  const A2 = 3 / 8 * (e2 + e2 * e2 / 4 + 15 * e2 * e2 * e2 / 128);
  const A4 = 15 / 256 * (e2 * e2 + 3 * e2 * e2 * e2 / 4);
  const A6 = 35 * e2 * e2 * e2 / 3072;

  const M = a * (A0 * latRad - A2 * Math.sin(2 * latRad) + A4 * Math.sin(4 * latRad) - A6 * Math.sin(6 * latRad));
  const M0 = a * (A0 * phi0Rad - A2 * Math.sin(2 * phi0Rad) + A4 * Math.sin(4 * phi0Rad) - A6 * Math.sin(6 * phi0Rad));

  // Easting
  const term1 = nu * Math.cos(latRad) * deltaLambda;
  const term2 = (nu / 6) * Math.pow(Math.cos(latRad), 3) * (1 - t2 + psi) * deltaLambda3;
  const term3 = (nu / 120) * Math.pow(Math.cos(latRad), 5) * (5 - 18 * t2 + t4 + 14 * psi - 58 * psi * t2) * deltaLambda5;
  
  const easting = E0 + m0 * (term1 + term2 + term3);

  // Northing
  const nTerm1 = M - M0;
  const nTerm2 = nu * Math.sin(latRad) * Math.cos(latRad) * deltaLambda2 / 2;
  const nTerm3 = (nu / 24) * Math.sin(latRad) * Math.pow(Math.cos(latRad), 3) * (5 - t2 + 9 * psi + 4 * psi * psi) * deltaLambda4;
  
  const northing = N0 + m0 * (nTerm1 + nTerm2 + nTerm3);

  return {
    northing: parseFloat(northing.toFixed(3)),
    easting: parseFloat(easting.toFixed(3))
  };
};

/**
 * Convert HK1980 Grid Coordinates to WGS84 Latitude and Longitude
 */
export const hk80ToWGS84 = (northing: number, easting: number): { latitude: number; longitude: number } => {
  const NPrime = northing - N0;
  const EPrime = easting - E0;

  // Calculate Footprint Latitude (phi_prime)
  const M_prime = NPrime / m0; // Meridian distance from origin

  // Coefficients for footprint latitude
  const A0 = 1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  
  const mu = M_prime / (a * A0); // Rectifying latitude
  
  // M0 term needs to be added to M_prime? 
  // Wait, M = M0 + (N - N0)/m0. 
  // Let's calculate M properly first.
  const A2 = 3 / 8 * (e2 + e2 * e2 / 4 + 15 * e2 * e2 * e2 / 128);
  const A4 = 15 / 256 * (e2 * e2 + 3 * e2 * e2 * e2 / 4);
  const A6 = 35 * e2 * e2 * e2 / 3072;
  const M0 = a * (A0 * phi0Rad - A2 * Math.sin(2 * phi0Rad) + A4 * Math.sin(4 * phi0Rad) - A6 * Math.sin(6 * phi0Rad));
  
  const M_actual = M0 + (northing - N0) / m0;
  const mu_actual = M_actual / (a * A0);

  const phi1 = mu_actual + (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu_actual)
               + (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu_actual)
               + (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu_actual)
               + (1097 * e1 * e1 * e1 * e1 / 512) * Math.sin(8 * mu_actual);

  const t1 = Math.tan(phi1);
  const t12 = t1 * t1;
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) * Math.sin(phi1));
  const r1 = a * (1 - e2) / Math.pow(1 - e2 * Math.sin(phi1) * Math.sin(phi1), 1.5);
  const D = EPrime / (n1 * m0);
  
  // Calculate Latitude
  const latTerm1 = (n1 * t1 / r1) * (D * D / 2);
  const latTerm2 = (n1 * t1 / r1) * (D * D * D * D / 24) * (5 + 3 * t12 + 10 * (n1 / r1) * (n1 / r1) - 4 * (n1 / r1) * (n1 / r1) - 9 * ePrime2);
  const latRad = phi1 - latTerm1 + latTerm2; // Approximation
  
  // Calculate Longitude
  const lonTerm1 = D;
  const lonTerm2 = (D * D * D / 6) * (1 + 2 * t12 + ePrime2);
  const lonTerm3 = (D * D * D * D * D / 120) * (5 + 28 * t12 + 24 * t12 * t12 + 6 * ePrime2 + 8 * ePrime2 * t12);
  const lonRad = lambda0Rad + (lonTerm1 - lonTerm2 + lonTerm3) / Math.cos(phi1);

  // Convert to Degrees (HK80)
  let latHK80 = latRad * (180 / Math.PI);
  let lonHK80 = lonRad * (180 / Math.PI);

  // Shift back to WGS84
  // Lat_WGS84 = Lat_HK80 + 5.5s
  // Lon_WGS84 = Lon_HK80 - 8.8s
  const latWGS84 = latHK80 + 0.0015277778;
  const lonWGS84 = lonHK80 - 0.0024444444;

  return {
      latitude: latWGS84,
      longitude: lonWGS84
  };
};