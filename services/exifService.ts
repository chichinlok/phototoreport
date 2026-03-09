import ExifReader from 'exifreader';
import { GPSCoordinates } from '../types';
import { wgs84ToHK80 } from './coordinateService';

export const extractPhotoMetadata = async (file: File): Promise<{ coordinates: GPSCoordinates | null, timestamp: string | null }> => {
  try {
    const tags = await ExifReader.load(file);
    
    // --- Extract Timestamp ---
    let timestamp: string | null = null;
    // Common EXIF date tags. Format is usually "YYYY:MM:DD HH:MM:SS" which is string-sortable.
    if (tags['DateTimeOriginal'] && tags['DateTimeOriginal'].description) {
      timestamp = tags['DateTimeOriginal'].description;
    } else if (tags['DateTime'] && tags['DateTime'].description) {
      timestamp = tags['DateTime'].description;
    } else if (tags['CreateDate'] && tags['CreateDate'].description) {
      timestamp = tags['CreateDate'].description;
    }

    // --- Extract GPS ---
    // Check if GPS tags exist
    if (!tags['GPSLatitude'] || !tags['GPSLongitude']) {
      return { coordinates: null, timestamp };
    }

    const latData = tags['GPSLatitude'].description;
    const latRef = tags['GPSLatitudeRef']?.value?.[0] || 'N';
    const lonData = tags['GPSLongitude'].description;
    const lonRef = tags['GPSLongitudeRef']?.value?.[0] || 'E';

    if (!latData || !lonData) return { coordinates: null, timestamp };

    const latCalc = convertDMSToDD(tags['GPSLatitude'].value as number[][], latRef as string);
    const lonCalc = convertDMSToDD(tags['GPSLongitude'].value as number[][], lonRef as string);

    if (isNaN(latCalc) || isNaN(lonCalc)) return { coordinates: null, timestamp };

    // Calculate HK1980 Grid Coordinates
    const hk80 = wgs84ToHK80(latCalc, lonCalc);

    // Extract Heading (GPSImgDirection)
    let heading: number | undefined;

    const parseHeading = (tagName: string): number | undefined => {
      const tag = tags[tagName];
      if (!tag) return undefined;

      // 1. Try direct numeric value
      if (typeof tag.value === 'number') {
        return tag.value;
      }
      
      // 2. Try Array (Rational or Single Number)
      if (Array.isArray(tag.value)) {
          // Rational [numerator, denominator]
          if (tag.value.length === 2 && typeof tag.value[1] === 'number' && tag.value[1] !== 0) {
              return Number(tag.value[0]) / Number(tag.value[1]);
          }
          // Single number in array
          if (tag.value.length === 1 && typeof tag.value[0] === 'number') {
              return Number(tag.value[0]);
          }
      }

      // 3. Try Description (String parsing)
      // ExifReader often puts "123.45 degrees" in description
      if (tag.description) {
         const floatVal = parseFloat(tag.description);
         if (!isNaN(floatVal)) return floatVal;
      }
      
      return undefined;
    };

    // Try GPSImgDirection first (Direction camera is facing)
    heading = parseHeading('GPSImgDirection');
    
    // Fallback to GPSDestBearing (Direction to destination, often used synonymously on some devices)
    if (heading === undefined) {
        heading = parseHeading('GPSDestBearing');
    }

    // Normalize to 0-360
    if (heading !== undefined) {
        heading = heading % 360;
        if (heading < 0) heading += 360;
    }

    return {
      coordinates: {
        latitude: latCalc,
        longitude: lonCalc,
        heading: heading,
        hk80: hk80
      },
      timestamp
    };

  } catch (error) {
    console.error("Error reading EXIF data:", error);
    return { coordinates: null, timestamp: null };
  }
};

// Convert Degrees, Minutes, Seconds to Decimal Degrees
const convertDMSToDD = (dms: number[][], ref: string): number => {
  if (!dms || dms.length < 3) return NaN;

  const degrees = dms[0][0] / dms[0][1];
  const minutes = dms[1][0] / dms[1][1];
  const seconds = dms[2][0] / dms[2][1];

  let dd = degrees + minutes / 60 + seconds / 3600;

  if (ref === 'S' || ref === 'W') {
    dd = dd * -1;
  }
  return dd;
};