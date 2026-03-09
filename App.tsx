import React, { useState, useRef, useEffect } from 'react';
import MapViewer from './components/MapViewer';
import PhotoSidebar from './components/PhotoSidebar';
import { PhotoData, MapBounds, MarkerLayout } from './types';
import { LucideMenu, LucideX } from 'lucide-react';
import { generateMapOverlayDoc } from './services/wordService';

function App() {
  const [photos, setPhotos] = useState<PhotoData[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  
  // Sidebar Resizing State
  const [sidebarWidth, setSidebarWidth] = useState(384); // Default 384px (w-96)
  const isResizingRef = useRef(false);

  // Selection State
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [pendingExportConfig, setPendingExportConfig] = useState<{ 
    format: 'A4' | 'A3', 
    orientation: 'portrait' | 'landscape',
    markersOnly?: boolean
  } | null>(null);
  
  // Imported Map State
  const [importedMapBlob, setImportedMapBlob] = useState<Blob | null>(null);
  const [importedMapBounds, setImportedMapBounds] = useState<MapBounds | null>(null);

  // Visual Settings State
  const [showCircle, setShowCircle] = useState(true);
  const [markerColor, setMarkerColor] = useState<string>('#3b82f6'); // Default Blue

  // Ref to the map container DOM element for screenshotting
  const mapContainerRef = useRef<HTMLDivElement>(null);

  // Resizing Logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
        if (isResizingRef.current) {
            // Constrain width between 280px and 800px
            const newWidth = Math.max(280, Math.min(e.clientX, 800));
            setSidebarWidth(newWidth);
        }
    };

    const handleMouseUp = () => {
        isResizingRef.current = false;
        document.body.style.cursor = 'default';
        document.body.style.userSelect = 'auto';
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleResizeStart = (e: React.MouseEvent) => {
      e.preventDefault();
      isResizingRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none'; // Prevent text selection while dragging
  };

  // Listen for selection init from Sidebar
  useEffect(() => {
    const handleInitSelection = async (e: Event) => {
        const detail = (e as CustomEvent).detail;
        
        // Always enter selection mode for "Extract Map CapScreen" buttons
        setPendingExportConfig(detail);
        setIsSelectionMode(true);
    };
    window.addEventListener('init-map-selection', handleInitSelection);
    return () => window.removeEventListener('init-map-selection', handleInitSelection);
  }, []);

  const handleSelectionComplete = async (bounds: MapBounds, blob: Blob, layout: MarkerLayout) => {
      setIsSelectionMode(false);
      
      if (pendingExportConfig) {
          // Exclude deleted AND reference photos from map overlay
          const activePhotos = photos.filter(p => !p.isDeleted && !p.isReference);
          try {
              let imageToUse: Blob | null = blob; // Default to screen capture
              let boundsToUse: MapBounds = bounds; // Default to selection bounds
              let layoutToUse: MarkerLayout | undefined = layout; // Default to screen layout

              // If we have an imported map, CROP it to the selection bounds
              if (importedMapBlob && importedMapBounds) {
                  const img = await new Promise<HTMLImageElement>((resolve) => { 
                      const i = new Image(); 
                      i.onload = () => resolve(i); 
                      i.src = URL.createObjectURL(importedMapBlob); 
                  });

                  // Calculate geometry
                  const mapLatSpan = importedMapBounds.north - importedMapBounds.south;
                  const mapLonSpan = importedMapBounds.east - importedMapBounds.west;

                  // Selection relative to Imported Map
                  // WGS84: West is smaller, East is larger.
                  // Image X: 0 is West, Width is East.
                  const x = ((bounds.west - importedMapBounds.west) / mapLonSpan) * img.width;
                  const w = ((bounds.east - bounds.west) / mapLonSpan) * img.width;

                  // WGS84: South is smaller, North is larger.
                  // Image Y: 0 is North (Max Lat), Height is South (Min Lat).
                  // So Y starts at (MapNorth - SelectionNorth)
                  const y = ((importedMapBounds.north - bounds.north) / mapLatSpan) * img.height;
                  const h = ((bounds.north - bounds.south) / mapLatSpan) * img.height;

                  // Create Crop Canvas
                  const canvas = document.createElement('canvas');
                  canvas.width = w; 
                  canvas.height = h;
                  const ctx = canvas.getContext('2d');
                  
                  if (ctx) {
                      // Draw only the selected slice
                      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
                      
                      const croppedBlob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'));
                      if (croppedBlob) {
                          imageToUse = croppedBlob;
                      }
                  }

                  // Use the selection bounds for the new document geography
                  boundsToUse = bounds; 
                  // Force recalculation of marker positions based on the new cropped aspect ratio
                  layoutToUse = undefined; 
              } else if (pendingExportConfig.markersOnly) {
                   // If no imported map but "Markers Only" selected
                   // We want a transparent background (null image)
                   imageToUse = null;
              }

              await generateMapOverlayDoc(
                  activePhotos, 
                  boundsToUse, 
                  pendingExportConfig.format, 
                  pendingExportConfig.orientation, 
                  imageToUse, 
                  layoutToUse,
                  showCircle,
                  markerColor
              );
          } catch (error) {
              console.error("Export Error", error);
              alert("Export Failed: " + (error as Error).message);
          }
      }
      setPendingExportConfig(null);
  };

  const handleImportedMapChange = (blob: Blob | null, bounds?: MapBounds) => {
      setImportedMapBlob(blob);
      if (bounds) {
          setImportedMapBounds(bounds);
      } else {
          setImportedMapBounds(null);
      }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-screen overflow-hidden bg-gray-100">
      
      {/* Mobile Sidebar Toggle */}
      <div className="md:hidden fixed top-4 left-4 z-[500]">
        <button 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="bg-white p-2 rounded shadow text-gray-700"
        >
          {isSidebarOpen ? <LucideX size={24}/> : <LucideMenu size={24}/>}
        </button>
      </div>

      {/* Sidebar Container */}
      <div 
        className={`
          fixed md:relative inset-y-0 left-0 z-[450] transform 
          ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} 
          md:translate-x-0 transition-transform duration-300 ease-in-out
          flex-shrink-0 h-full w-80 md:w-auto
        `}
        style={{ width: window.innerWidth >= 768 ? sidebarWidth : undefined }}
      >
        <PhotoSidebar 
          photos={photos} 
          setPhotos={setPhotos} 
          selectedPhotoId={selectedPhotoId} 
          onSelectPhoto={setSelectedPhotoId}
          mapBounds={mapBounds}
          mapContainerRef={mapContainerRef}
          onImportedMapChange={handleImportedMapChange}
        />
        
        {/* Sidebar Resize Handle (Desktop Only) */}
        <div 
            onMouseDown={handleResizeStart}
            className="hidden md:block absolute top-0 right-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-400 z-50 transition-colors"
        />
      </div>

      {/* Main Map Area */}
      <div className="flex-1 relative h-full w-full">
        <MapViewer 
          photos={photos} 
          selectedPhotoId={selectedPhotoId} 
          onSelectPhoto={(id) => {
            setSelectedPhotoId(id);
            if (window.innerWidth < 768) {
               setIsSidebarOpen(true);
            }
          }}
          onBoundsChange={setMapBounds}
          containerRef={mapContainerRef}
          isSelectionMode={isSelectionMode}
          onSelectionComplete={handleSelectionComplete}
          showCircle={showCircle}
          onToggleCircle={() => setShowCircle(!showCircle)}
          markerColor={markerColor}
          onColorChange={setMarkerColor}
        />
        
        {/* Helper overlay if no photos */}
        {photos.length === 0 && (
           <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 pointer-events-none z-[400] text-center bg-white/80 backdrop-blur-md p-6 rounded-2xl shadow-xl border border-white/50">
              <h1 className="text-2xl font-bold text-gray-800 mb-2">Welcome to GeoInfo Map</h1>
              <p className="text-gray-600">Upload photos with GPS data to get started.</p>
           </div>
        )}
      </div>
    </div>
  );
}

export default App;