import React, { useEffect, useState, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { PhotoData, MapBounds, MarkerLayout } from '../types';
import { LucideMapPin, LucideNavigation, LucideLocateFixed, LucideExternalLink, LucideCircle, LucideCircleOff, LucidePalette } from 'lucide-react';
// @ts-ignore
import html2canvas from 'html2canvas';

// Custom hook to handle map movement
const MapController: React.FC<{ 
  center: [number, number] | null, 
  zoom: number,
  selectedId: string | null 
}> = ({ center, zoom, selectedId }) => {
  const map = useMap();
  
  useEffect(() => {
    if (center) {
      map.flyTo(center, zoom, {
        animate: true,
        duration: 1.0, 
        easeLinearity: 0.25
      });
    }
  }, [center, map, selectedId, zoom]);

  return null;
};

// Function to create a custom HTML icon with arrow and circle connected by a line
const createDirectionalIcon = (number: number, isSelected: boolean, heading: number | null, lineLength: number, showCircle: boolean, customColor: string) => {
  const color = isSelected ? '#ef4444' : customColor; // Red if selected, customColor otherwise
  const rotation = heading ?? 0;

  // Geometry Settings
  const headLen = 18; // Wide arrow head length
  const headWidth = 24; // Wide arrow base
  const radius = 20; // Radius 20px (Diameter 40px)
  const lineLen = lineLength; 
  
  // Font settings
  const fontSize = 24; // Font size 24px

  // Total distance from center (arrow tip) to the furthest edge of the circle
  const extension = headLen + lineLen + radius * 2;
  
  // Dynamic canvas size to prevent clipping when line is long
  const size = (extension * 2) + 60; 
  const center = size / 2;
  
  // Y position of circle center in un-rotated frame (pointing UP)
  // Tip is at (center, center)
  // We draw pointing UP (North), so Y decreases.
  const circleCenterY = center - headLen - lineLen - radius;

  // Counter-rotation for text so it remains upright
  const textRotation = -rotation;

  return L.divIcon({
    className: 'custom-directional-icon',
    html: `
      <div style="
        position: relative;
        width: ${size}px;
        height: ${size}px;
        pointer-events: none;
      ">
        <!-- Rotatable Container -->
        <div style="
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          transform-origin: ${center}px ${center}px;
          transform: rotate(${rotation}deg);
          pointer-events: auto;
        ">
           <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="overflow: visible;">
             
             <!-- Line (Shaft) -->
             <line 
               x1="${center}" y1="${center - headLen + 2}" 
               x2="${center}" y2="${circleCenterY + radius}" 
               stroke="${color}" 
               stroke-width="3" 
             />
             
             <!-- Arrow Head (Filled) at Tip -->
             <!-- Points UP (North) in SVG space (Y decreases) -->
             <path 
               d="M ${center} ${center} L ${center - (headWidth/2)} ${center - headLen} L ${center + (headWidth/2)} ${center - headLen} Z" 
               fill="${color}" 
               stroke="none"
             />
             
             <!-- Circle at Tail (No Fill) -->
             <circle 
               cx="${center}" 
               cy="${circleCenterY}" 
               r="${radius}" 
               fill="white" 
               fill-opacity="0.01" 
               stroke="${showCircle ? color : 'none'}" 
               stroke-width="3" 
             />
           </svg>
           
           <!-- Number Label (Counter-Rotated) -->
           <div style="
              position: absolute;
              top: ${circleCenterY - radius}px;
              left: ${center - radius}px;
              width: ${radius * 2}px;
              height: ${radius * 2}px;
              display: flex;
              align-items: center;
              justify-content: center;
              transform: rotate(${textRotation}deg);
           ">
              <span style="
                color: ${color};
                font-weight: bold;
                font-family: sans-serif;
                font-size: ${fontSize}px; 
                text-shadow: 0 0 3px rgba(255,255,255,1);
                line-height: 1;
              ">${number}</span>
           </div>
        </div>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [center, center], 
    popupAnchor: [0, 0] 
  });
};

// --- Collision Detection Helpers ---

interface Point { x: number; y: number; }
interface LabelItem {
  x: number;
  y: number;
  r: number;
}
interface PlacedItem {
  label: LabelItem;
  anchor: Point;
  id: string;
}

// Distance squared between two points
const dist2 = (v: Point, w: Point) => (v.x - w.x) ** 2 + (v.y - w.y) ** 2;

// Distance squared from point p to segment v-w
const distToSegmentSquared = (p: Point, v: Point, w: Point) => {
  const l2 = dist2(v, w);
  if (l2 === 0) return dist2(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
};

// Check if two line segments intersect
// p0-p1 is the new line, p2-p3 is the existing line
const segmentsIntersect = (p0: Point, p1: Point, p2: Point, p3: Point): boolean => {
  const s1_x = p1.x - p0.x;
  const s1_y = p1.y - p0.y;
  const s2_x = p3.x - p2.x;
  const s2_y = p3.y - p2.y;

  const denom = -s2_x * s1_y + s1_x * s2_y;
  
  // Parallel lines
  if (denom === 0) return false;

  const s = (-s1_y * (p0.x - p2.x) + s1_x * (p0.y - p2.y)) / denom;
  const t = ( s2_x * (p0.y - p2.y) - s2_y * (p0.x - p2.x)) / denom;

  // Collision detected if intersection is strictly within segments
  // We use a small buffer (0.05) to ignore intersections at the very start (shared anchors)
  return (s >= 0.05 && s <= 0.95 && t >= 0.05 && t <= 0.95);
};

// Check if a proposed marker placement collides with existing ones
const isColliding = (
  cLabel: LabelItem,
  cAnchor: Point,
  existingItems: PlacedItem[]
): boolean => {
  const PADDING = 5; 

  for (const item of existingItems) {
    // 1. Label vs Label Collision (Circle overlap)
    const dx = cLabel.x - item.label.x;
    const dy = cLabel.y - item.label.y;
    const distSq = dx * dx + dy * dy;
    const minDesc = (cLabel.r + item.label.r + PADDING);
    if (distSq < minDesc * minDesc) return true;

    // 2. New Line vs Existing Label (Prevent arrow pointing through a circle)
    // Distance from Existing Label Center to New Line Segment
    if (distToSegmentSquared({ x: item.label.x, y: item.label.y }, cAnchor, { x: cLabel.x, y: cLabel.y }) < (item.label.r + 5) ** 2) {
      return true;
    }

    // 3. Existing Line vs New Label (Prevent new circle overlapping an old arrow line)
    // Distance from New Label Center to Existing Line Segment
    if (distToSegmentSquared({ x: cLabel.x, y: cLabel.y }, item.anchor, { x: item.label.x, y: item.label.y }) < (cLabel.r + 5) ** 2) {
      return true;
    }
    
    // 4. Line vs Line Intersection (Prevent crossing arrows)
    // New Line: cAnchor -> cLabel center
    // Existing Line: item.anchor -> item.label center
    if (segmentsIntersect(cAnchor, { x: cLabel.x, y: cLabel.y }, item.anchor, { x: item.label.x, y: item.label.y })) {
      return true;
    }
  }
  return false;
};

// Component to manage markers with collision detection
const MarkerLayer: React.FC<{
  photos: PhotoData[];
  selectedPhotoId: string | null;
  onSelectPhoto: (id: string) => void;
  onLayoutChange?: (layout: MarkerLayout) => void;
  showCircle?: boolean;
  markerColor: string;
}> = ({ photos, selectedPhotoId, onSelectPhoto, onLayoutChange, showCircle = true, markerColor }) => {
  const map = useMap();
  const [layout, setLayout] = useState<MarkerLayout>({});

  // Memoize sorted photos to ensure stable rendering order (by sequence)
  const sortedPhotos = useMemo(() => {
    return [...photos].sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
  }, [photos]);

  const updateLayout = () => {
    const newLayout: MarkerLayout = {};
    const placedItems: PlacedItem[] = [];
    
    // Geometry Constants match createDirectionalIcon
    const headLen = 18; 
    const radius = 20; 
    
    // Minimum Distance: Gap should be roughly circle dimension (40px)
    const minLineLen = 40; 
    
    // Search parameters
    const angleStep = 2; // Finer grain
    const maxAngleDev = 5; // Restricted to 5 degrees to maintain accuracy
    const lenStep = 10; 
    const maxLenAttempts = 8; 

    sortedPhotos.forEach(photo => {
      if (!photo.coordinates) return;

      const pt = map.latLngToContainerPoint([photo.coordinates.latitude, photo.coordinates.longitude]);
      
      const rawHeading = photo.coordinates.heading ?? 0;
      const baseHeading = (rawHeading + 180) % 360;
      
      let bestLen = minLineLen;
      let bestAngle = baseHeading;
      let found = false;
      
      outerLoop:
      for (let l = 0; l < maxLenAttempts; l++) {
        const currentLen = minLineLen + (l * lenStep);
        
        // Try angles: 0, +2, -2, +4, -4...
        for (let a = 0; a <= maxAngleDev; a += angleStep) {
           const deviations = a === 0 ? [0] : [a, -a];
           
           for (const dev of deviations) {
              const testAngle = baseHeading + dev;
              const rad = (testAngle * Math.PI) / 180;
              
              // Calculate proposed Label Center
              const totalDist = headLen + currentLen + radius;
              
              const lx = pt.x + totalDist * Math.sin(rad);
              const ly = pt.y - totalDist * Math.cos(rad);
              
              const cLabel = { x: lx, y: ly, r: radius };
              
              if (!isColliding(cLabel, pt, placedItems)) {
                 bestLen = currentLen;
                 bestAngle = testAngle;
                 found = true;
                 break outerLoop;
              }
           }
        }
      }

      newLayout[photo.id] = { len: bestLen, angle: bestAngle };
      
      const rad = (bestAngle * Math.PI) / 180;
      const totalDist = headLen + bestLen + radius;
      placedItems.push({
         id: photo.id,
         anchor: { x: pt.x, y: pt.y },
         label: {
            x: pt.x + totalDist * Math.sin(rad),
            y: pt.y - totalDist * Math.cos(rad),
            r: radius
         }
      });
    });

    setLayout(newLayout);
    if (onLayoutChange) {
      onLayoutChange(newLayout);
    }
  };

  useMapEvents({
    zoomend: updateLayout,
    moveend: updateLayout // Re-calc on move as pixel coords change
  });

  useEffect(() => {
    updateLayout();
  }, [sortedPhotos]);

  return (
    <>
      {sortedPhotos.map((photo) => {
        if (!photo.coordinates) return null;
        const isSelected = photo.id === selectedPhotoId;
        const labelNumber = photo.sequenceNumber || 0;
        
        const rawHeading = photo.coordinates.heading ?? 0;
        // Default if layout not ready
        const defaultAngle = (rawHeading + 180) % 360; 

        const { len, angle } = layout[photo.id] || { len: 40, angle: defaultAngle };

        return (
          <Marker 
            key={photo.id}
            position={[photo.coordinates.latitude, photo.coordinates.longitude]}
            icon={createDirectionalIcon(labelNumber, isSelected, angle, len, showCircle, markerColor)}
            eventHandlers={{
              click: () => onSelectPhoto(photo.id),
            }}
          >
            <Popup className="custom-popup">
                <div className="flex flex-col items-center p-1 min-w-[180px]">
                  <div className="w-32 h-32 mb-2 overflow-hidden rounded-lg bg-gray-100 border border-gray-200">
                    <img src={photo.previewUrl} alt="Thumbnail" className="w-full h-full object-cover"/>
                  </div>
                  <span className="font-bold text-sm text-gray-800 text-center leading-tight mb-2 truncate max-w-full px-2">
                    {photo.name}
                  </span>
                  
                  {/* WGS84 Coords */}
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-600 bg-gray-50 px-2 py-1 rounded-full border border-gray-100 font-mono mb-1 w-full justify-center">
                    <LucideMapPin size={10} />
                    <span>
                      Lat/Lon: {photo.coordinates.latitude.toFixed(5)}, {photo.coordinates.longitude.toFixed(5)}
                    </span>
                  </div>

                  {/* HK1980 Coords */}
                  {photo.coordinates.hk80 && (
                     <div className="flex items-center gap-1.5 text-[10px] text-indigo-700 bg-indigo-50 px-2 py-1 rounded-full border border-indigo-100 font-mono w-full justify-center mb-1">
                        <LucideLocateFixed size={10} />
                        <span>
                          HK80: N {photo.coordinates.hk80.northing} E {photo.coordinates.hk80.easting}
                        </span>
                     </div>
                  )}

                  {/* Heading Info */}
                  <div className="flex items-center gap-1.5 text-[10px] text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full border border-emerald-100 font-mono w-full justify-center mb-1">
                    <LucideNavigation size={10} className="transform rotate-45" />
                    <span>
                       Heading: {photo.coordinates.heading !== undefined ? photo.coordinates.heading.toFixed(0) + '°' : 'N/A'}
                    </span>
                  </div>

                  {/* Open in Map.gov.hk */}
                  <a 
                    href={`https://www.map.gov.hk/gm/`} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    className="flex items-center gap-1 text-[10px] text-blue-600 hover:text-blue-800 hover:underline mt-1"
                    title="Go to GeoInfo Map"
                  >
                     <LucideExternalLink size={10} />
                     Open GeoInfo Map
                  </a>
                </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
};

// --- Selection Overlay Component ---
const SelectionOverlay: React.FC<{
  active: boolean;
  onComplete: (bounds: MapBounds, blob: Blob) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}> = ({ active, onComplete, containerRef }) => {
  const map = useMap();
  const [startPoint, setStartPoint] = useState<Point | null>(null);
  const [currentPoint, setCurrentPoint] = useState<Point | null>(null);

  if (!active) return null;

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setStartPoint({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
      setCurrentPoint({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!startPoint) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      setCurrentPoint({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
    }
  };

  const handleMouseUp = async (e: React.MouseEvent) => {
    if (!startPoint || !currentPoint || !containerRef.current) return;
    
    // Calculate Box
    const x = Math.min(startPoint.x, currentPoint.x);
    const y = Math.min(startPoint.y, currentPoint.y);
    const w = Math.abs(currentPoint.x - startPoint.x);
    const h = Math.abs(currentPoint.y - startPoint.y);

    if (w < 10 || h < 10) {
      // Ignore tiny clicks
      setStartPoint(null);
      setCurrentPoint(null);
      return;
    }

    // 1. Calculate Geo Bounds of the crop
    const topLeft = map.containerPointToLatLng([x, y]);
    const bottomRight = map.containerPointToLatLng([x + w, y + h]);
    
    const cropBounds: MapBounds = {
      north: topLeft.lat,
      west: topLeft.lng,
      south: bottomRight.lat,
      east: bottomRight.lng
    };

    // 2. Capture Logic
    try {
      // Temporarily hide UI elements for clean capture
      setStartPoint(null); // Hide selection box
      containerRef.current.classList.add('hide-markers');

      // Capture full map
      const fullCanvas = await html2canvas(containerRef.current, {
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff', // FORCE WHITE BACKGROUND instead of transparent
        ignoreElements: (el: Element) => el.classList.contains('leaflet-control-container')
      });
      
      containerRef.current.classList.remove('hide-markers');

      // Crop canvas
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = w;
      cropCanvas.height = h;
      const ctx = cropCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(fullCanvas, x, y, w, h, 0, 0, w, h);
        cropCanvas.toBlob((blob) => {
          if (blob) {
            onComplete(cropBounds, blob);
          }
        }, 'image/png');
      }

    } catch (err) {
      console.error("Selection Capture Failed", err);
      containerRef.current.classList.remove('hide-markers');
    }

    setStartPoint(null);
    setCurrentPoint(null);
  };

  const boxStyle: React.CSSProperties = {
     position: 'absolute',
     border: '2px dashed #3b82f6',
     backgroundColor: 'rgba(59, 130, 246, 0.2)',
     pointerEvents: 'none',
     left: startPoint && currentPoint ? Math.min(startPoint.x, currentPoint.x) : 0,
     top: startPoint && currentPoint ? Math.min(startPoint.y, currentPoint.y) : 0,
     width: startPoint && currentPoint ? Math.abs(currentPoint.x - startPoint.x) : 0,
     height: startPoint && currentPoint ? Math.abs(currentPoint.y - startPoint.y) : 0,
     display: startPoint ? 'block' : 'none'
  };

  return (
    <div 
      className="absolute inset-0 z-[1000] cursor-crosshair bg-black/10"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div style={boxStyle}></div>
      {!startPoint && (
         <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-white/90 px-4 py-2 rounded-full shadow-lg text-sm font-semibold text-gray-700 pointer-events-none border border-gray-200">
           Drag to select area for capture
         </div>
      )}
    </div>
  );
};


interface MapViewerProps {
  photos: PhotoData[];
  selectedPhotoId: string | null;
  onSelectPhoto: (id: string) => void;
  onBoundsChange?: (bounds: MapBounds) => void;
  containerRef?: React.RefObject<HTMLDivElement | null>;
  isSelectionMode?: boolean;
  onSelectionComplete?: (bounds: MapBounds, blob: Blob, layout: MarkerLayout) => void;
  showCircle?: boolean;
  onToggleCircle?: () => void;
  markerColor?: string;
  onColorChange?: (color: string) => void;
}

const MapViewer: React.FC<MapViewerProps> = ({ 
  photos, 
  selectedPhotoId, 
  onSelectPhoto, 
  onBoundsChange,
  containerRef,
  isSelectionMode = false,
  onSelectionComplete,
  showCircle = true,
  onToggleCircle,
  markerColor = '#3B82F6',
  onColorChange
}) => {
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [zoom, setZoom] = useState(13); // Default zoom

  // State to hold the layout from MarkerLayer to pass to selection
  const [currentLayout, setCurrentLayout] = useState<MarkerLayout>({});

  // Filter out deleted AND reference photos from the map
  const activePhotos = useMemo(() => photos.filter(p => !p.isDeleted && !p.isReference), [photos]);

  useEffect(() => {
    if (activePhotos.length > 0) {
      if (selectedPhotoId) {
        const photo = activePhotos.find(p => p.id === selectedPhotoId);
        if (photo && photo.coordinates) {
          setMapCenter([photo.coordinates.latitude, photo.coordinates.longitude]);
          setZoom(18); // Close zoom on selection
        }
      } else if (!mapCenter) {
         // Initial Center on first photo if map not centered
         const first = activePhotos[0];
         if (first.coordinates) {
             setMapCenter([first.coordinates.latitude, first.coordinates.longitude]);
         }
      }
    } else {
       // Default Hong Kong
       if (!mapCenter) setMapCenter([22.3193, 114.1694]);
    }
  }, [selectedPhotoId, activePhotos]);

  // Capture bounds move
  const MapBoundsReporter = () => {
    const map = useMapEvents({
      moveend: () => {
        const b = map.getBounds();
        if (onBoundsChange) {
            onBoundsChange({
                north: b.getNorth(),
                south: b.getSouth(),
                east: b.getEast(),
                west: b.getWest()
            });
        }
      }
    });
    return null;
  };

  return (
    <div className="h-full w-full relative" ref={containerRef}>
      <MapContainer
        center={mapCenter || [22.3193, 114.1694]}
        zoom={zoom}
        style={{ height: '100%', width: '100%', zIndex: 0 }}
        zoomSnap={0} // Smooth zoom
        zoomDelta={0.5}
        wheelPxPerZoomLevel={120}
      >
        {/* Lands Department Maps (Hong Kong) */}
        <TileLayer
          attribution='&copy; <a href="https://www.map.gov.hk/gm/">Hong Kong SAR Government</a>'
          url="https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/wgs84/{z}/{x}/{y}.png"
          crossOrigin="anonymous" 
        />
        <TileLayer
          url="https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/label/hk/en/wgs84/{z}/{x}/{y}.png"
          crossOrigin="anonymous"
        />
        
        <MapController center={mapCenter} zoom={zoom} selectedId={selectedPhotoId} />
        <MapBoundsReporter />
        
        {!isSelectionMode && (
            <MarkerLayer 
                photos={activePhotos} 
                selectedPhotoId={selectedPhotoId} 
                onSelectPhoto={onSelectPhoto}
                onLayoutChange={setCurrentLayout}
                showCircle={showCircle}
                markerColor={markerColor}
            />
        )}
        
        {isSelectionMode && onSelectionComplete && (
            <SelectionOverlay 
                active={isSelectionMode} 
                onComplete={(b, blob) => onSelectionComplete(b, blob, currentLayout)}
                containerRef={containerRef as React.RefObject<HTMLDivElement>}
            />
        )}
      </MapContainer>

      {/* Visual Controls (Toggle Circle, Color Picker) */}
      {!isSelectionMode && (
          <div className="absolute bottom-8 right-2 z-[400] flex flex-col gap-2">
               {/* Color Picker */}
               <div className="relative group">
                   <button className="bg-white p-2 rounded shadow text-gray-700 hover:bg-gray-50 border border-gray-300">
                       <LucidePalette size={20} style={{ color: markerColor }} />
                   </button>
                   <div className="absolute bottom-full right-0 mb-2 hidden group-hover:flex flex-col gap-1 bg-white p-2 rounded shadow-xl border border-gray-200">
                       {['#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#6366F1', '#14B8A6'].map(c => (
                           <button 
                             key={c} 
                             className="w-6 h-6 rounded-full border border-gray-200 hover:scale-110 transition-transform" 
                             style={{ backgroundColor: c }}
                             onClick={() => onColorChange && onColorChange(c)}
                           />
                       ))}
                   </div>
               </div>

              <button 
                  onClick={onToggleCircle}
                  className="bg-white p-2 rounded shadow text-gray-700 hover:bg-gray-50 border border-gray-300"
                  title={showCircle ? "Hide Circles" : "Show Circles"}
              >
                  {showCircle ? <LucideCircleOff size={20}/> : <LucideCircle size={20}/>}
              </button>
          </div>
      )}
    </div>
  );
};

export default MapViewer;