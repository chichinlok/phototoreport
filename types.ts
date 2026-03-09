export interface GPSCoordinates {
  latitude: number;
  longitude: number;
  heading?: number;
  hk80?: {
    northing: number;
    easting: number;
  };
}

export interface PhotoData {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  originalName?: string;
  isDeleted?: boolean;
  isReference?: boolean;
  sequenceNumber?: number;
  coordinates: GPSCoordinates | null;
  timestamp?: string;
  aiAnalysis?: string;
  isAnalyzing?: boolean;
}

export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export interface MapBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface MarkerLayout {
  [id: string]: {
    len: number;
    angle: number;
  };
}