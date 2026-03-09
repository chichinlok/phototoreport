import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { PhotoData, MapBounds } from '../types';
import { extractPhotoMetadata } from '../services/exifService';
import { analyzeLocationWithGemini } from '../services/geminiService';
import { generateWordDocument, generateWordFromTemplate, generateMapOverlayDoc } from '../services/wordService';
import { generateCompressedPdf } from '../services/pdfService';
import { hk80ToWGS84 } from '../services/coordinateService';
import { LucideUpload, LucideMapPin, LucideSparkles, LucideTrash2, LucideLoader2, LucidePen, LucideFileText, LucideFileUp, LucideUndo, LucideLocateFixed, LucidePlusCircle, LucideX, LucideGripVertical, LucideImage, LucideCrop, LucideMap, LucideCrosshair, LucideCheck, LucideLayers, LucideFileDigit, LucideBookImage, LucideCheckCircle2, LucideCloud, LucideLink, LucideDownload, LucideExternalLink, LucideChevronLeft, LucideChevronRight, LucideGrid, LucidePlus, LucideRotateCcw } from 'lucide-react';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import { createWorker } from 'tesseract.js';

// Fix for PDF.js import in ESM environment (handle default vs named exports)
const pdfjs = (pdfjsLib as any).default || pdfjsLib;

// Setup PDF Worker
if (pdfjs.GlobalWorkerOptions) {
    // Use cdnjs for reliable worker loading with correct CORS headers
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

interface PhotoSidebarProps {
  photos: PhotoData[];
  setPhotos: React.Dispatch<React.SetStateAction<PhotoData[]>>;
  selectedPhotoId: string | null;
  onSelectPhoto: (id: string | null) => void;
  mapBounds: MapBounds | null;
  mapContainerRef: React.RefObject<HTMLDivElement | null>;
  onImportedMapChange: (blob: Blob | null, bounds?: MapBounds) => void;
}

interface CalibrationPoint {
  x: number;
  y: number;
  north: string;
  east: string;
}

interface CoordinateCandidate {
    val: number;
    x: number;
    y: number;
    type: 'N' | 'E' | 'Unknown';
    source: 'horizontal' | 'vertical';
}

const PhotoSidebar: React.FC<PhotoSidebarProps> = ({ photos, setPhotos, selectedPhotoId, onSelectPhoto, mapBounds, mapContainerRef, onImportedMapChange }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const insertInputRef = useRef<HTMLInputElement>(null);
  const mapImportRef = useRef<HTMLInputElement>(null);
  
  // Undo History State
  const [history, setHistory] = useState<PhotoData[][]>([]);
  
  // Track where to insert new photo (index) - Use Ref for immediate access in event handlers
  const insertAtIndexRef = useRef<number | null>(null);
  const [insertAtIndex, setInsertAtIndex] = useState<number | null>(null); // Keep state for UI updates if needed

  const [isProcessing, setIsProcessing] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string>("Processing...");
  const [uploadSuccess, setUploadSuccess] = useState(false); // Success state

  const [isExporting, setIsExporting] = useState(false);
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  
  // Drag and drop state
  const [draggedId, setDraggedId] = useState<string | null>(null);

  // Calibration State
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationImage, setCalibrationImage] = useState<string | null>(null); // Data URL
  const [calibrationBlob, setCalibrationBlob] = useState<Blob | null>(null);
  const [points, setPoints] = useState<CalibrationPoint[]>([]);
  const calibrationImgRef = useRef<HTMLImageElement>(null);
  const [detectedMapInfo, setDetectedMapInfo] = useState<string | null>(null);

  // Mega Import State
  const [showMegaModal, setShowMegaModal] = useState(false);
  const [megaLink, setMegaLink] = useState("");
  const [megaLoading, setMegaLoading] = useState(false);
  const [megaStatus, setMegaStatus] = useState("");
  const [megaError, setMegaError] = useState<string | null>(null);

  // Grid View State
  const [showGridModal, setShowGridModal] = useState(false);

  // --- HISTORY MANAGEMENT ---
  const saveHistory = () => {
      setHistory(prev => [...prev.slice(-20), photos]); // Keep last 20 states
  };

  const handleUndo = () => {
      if (history.length === 0) return;
      const previousState = history[history.length - 1];
      setHistory(prev => prev.slice(0, -1));
      setPhotos(previousState);
  };

  // Helper to update photos with automatic history saving
  const modifyPhotos = (updateFn: (currentPhotos: PhotoData[]) => PhotoData[]) => {
      setHistory(prev => [...prev.slice(-20), photos]);
      setPhotos(updateFn);
  };

  const resequencePhotos = (photoList: PhotoData[]): PhotoData[] => {
      let currentSequence = 1;
      return photoList.map(photo => {
        // Skip deleted photos in the numbering sequence logic
        if (photo.isDeleted) return photo;

        // Reference photos logic: No sequence number, specific name
        if (photo.isReference) {
           let newName = photo.name;
           // If the name was a generated "Photo direction X", change it to Reference
           if (/^Photo direction \d+$/.test(photo.name)) {
             newName = "Reference Photo";
           }
           return {
             ...photo,
             sequenceNumber: undefined,
             name: newName
           };
        }

        const newSequence = currentSequence++;
        let newName = photo.name;

        // If the name follows the standard pattern "Photo direction X" or was "Reference Photo", update it
        const pattern = /^Photo direction \d+$/;
        if (pattern.test(photo.name) || photo.name === 'Reference Photo' || photo.name === 'Photo direction 0') {
          newName = `Photo direction ${newSequence}`;
        }

        return {
          ...photo,
          sequenceNumber: newSequence,
          name: newName
        };
      });
  };

  const handleNameChange = (id: string, newName: string) => {
    // Note: Name changes don't typically trigger history to avoid flooding stack with keystrokes
    setPhotos(prev => prev.map(p => p.id === id ? { ...p, name: newName } : p));
  };

  const processFiles = async (files: File[], targetIndex?: number | null) => {
    if (files.length === 0) return;

    setIsProcessing(true);
    setUploadSuccess(false);
    setLoadingMessage("Processing photos...");
    
    // Save history before adding new files
    saveHistory();

    try {
      const uniqueFiles = files.filter(newFile => {
        const isDuplicate = photos.some(existingPhoto => 
          !existingPhoto.isDeleted &&
          existingPhoto.file.name === newFile.name &&
          existingPhoto.file.size === newFile.size &&
          existingPhoto.file.lastModified === newFile.lastModified
        );
        return !isDuplicate;
      });

      if (uniqueFiles.length === 0) {
        setIsProcessing(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        if (insertInputRef.current) insertInputRef.current.value = '';
        return;
      }

      const newPhotos = await Promise.all(
        uniqueFiles.map(async (file: File) => {
          const { coordinates, timestamp } = await extractPhotoMetadata(file);
          return {
            id: crypto.randomUUID(),
            file: file,
            previewUrl: URL.createObjectURL(file),
            name: `Photo direction 0`, 
            sequenceNumber: 0, 
            coordinates: coordinates,
            timestamp: timestamp || undefined, // Store extracted timestamp
            aiAnalysis: undefined
          };
        })
      );

      // Sort the NEW batch of photos chronologically by timestamp
      newPhotos.sort((a, b) => {
          const tA = a.timestamp || '';
          const tB = b.timestamp || '';
          if (tA && tB) return tA.localeCompare(tB);
          if (tA) return -1; // Prioritize photos with timestamps
          if (tB) return 1;
          return a.name.localeCompare(b.name); // Fallback to filename/name
      });

      setPhotos(prev => {
          let updatedList = [...prev];
          if (targetIndex !== undefined && targetIndex !== null) {
              // Insert at specific index
              const insertPos = Math.min(Math.max(0, targetIndex), updatedList.length);
              updatedList.splice(insertPos, 0, ...newPhotos);
          } else {
              // Append to end
              updatedList = [...updatedList, ...newPhotos];
          }
          return resequencePhotos(updatedList);
      });

      if (newPhotos.length > 0) {
        // Do NOT select the photo automatically. Show list instead.
        onSelectPhoto(null);
        // Trigger success message
        setUploadSuccess(true);
        setTimeout(() => setUploadSuccess(false), 5000);
      }
    } catch (error) {
      console.error("Error processing photos:", error);
      alert("Failed to process some photos.");
    } finally {
      setIsProcessing(false);
      setInsertAtIndex(null);
      insertAtIndexRef.current = null;
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (insertInputRef.current) insertInputRef.current.value = '';
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, targetIndex?: number) => {
      const files = event.target.files;
      if (files) {
          // Priority: Explicit arg -> Ref -> State -> Null
          const idx = targetIndex ?? insertAtIndexRef.current ?? insertAtIndex ?? null;
          await processFiles(Array.from(files), idx);
      }
  };

  const triggerInsert = (index: number) => {
      insertAtIndexRef.current = index;
      setInsertAtIndex(index);
      insertInputRef.current?.click();
  };

  const handleTemplateUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      setTemplateFile(files[0]);
    }
  };

  // Mega.io Handlers
  const handleMegaImport = async () => {
    if (!megaLink.trim()) return;
    
    setMegaLoading(true);
    setMegaError(null);
    setMegaStatus("Initializing...");
    
    // Split by newlines, commas, or spaces.
    const rawLinks = megaLink.split(/[\n\r,]+/);
    const links = rawLinks.map(l => l.trim()).filter(l => l.length > 0);
    const filesToProcess: File[] = [];
    const errors: string[] = [];

    try {
        // @ts-ignore
        const { File: MegaFile } = await import('megajs');
        
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            setMegaStatus(`Downloading ${i + 1}/${links.length}...`);

            try {
                // Basic validation
                if (!link.includes('mega.nz') && !link.includes('mega.io')) {
                     throw new Error(`Invalid URL: ${link.substring(0, 30)}...`);
                }

                const file = MegaFile.fromURL(link);
                await file.loadAttributes();
                
                if (file.directory) {
                     throw new Error(`Folder link ignored: ${link.substring(0, 20)}...`);
                }

                const data = await file.downloadBuffer();
                
                const name = file.name || `mega_import_${i}.jpg`;
                let type = 'image/jpeg';
                if (name.toLowerCase().endsWith('.png')) type = 'image/png';
                if (name.toLowerCase().endsWith('.webp')) type = 'image/webp';
                
                const importedFile = new File([data], name, { type });
                filesToProcess.push(importedFile);
                
            } catch (err: any) {
                console.error(err);
                errors.push(`Link ${i+1}: ${err.message}`);
            }
        }
        
        if (filesToProcess.length > 0) {
            setMegaStatus("Processing photos...");
            await processFiles(filesToProcess, insertAtIndex ?? null);
            setUploadSuccess(true);
        }

        if (errors.length === 0) {
            setMegaLink("");
            setShowMegaModal(false);
        } else {
            if (filesToProcess.length > 0) {
                setMegaError(`Imported ${filesToProcess.length} files. ${errors.length} failed.\n${errors[0]}`);
            } else {
                setMegaError(`All imports failed.\n${errors.slice(0, 3).join('\n')}`);
            }
        }

    } catch (err: any) {
        console.error(err);
        setMegaError(err.message || "Failed to initialize Mega import.");
    } finally {
        setMegaLoading(false);
        setMegaStatus("");
    }
  };


  // Helper to process words into candidates
  const extractCandidates = (words: any[], source: 'horizontal' | 'vertical'): CoordinateCandidate[] => {
      if (!words) return [];
      const candidates: CoordinateCandidate[] = [];
      for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const rawText = w.text.trim().toUpperCase();
            // Clean digits only for value parsing
            const cleanDigits = rawText.replace(/[^0-9]/g, '');
            
            let val = 0;
            let bbox = w.bbox;
            let type: 'N' | 'E' | 'Unknown' = 'Unknown';
            let matched = false;

            // Check for direction in current word
            if (rawText.includes('N')) type = 'N';
            else if (rawText.includes('E')) type = 'E';

            // Pattern 1: Contiguous 6-digit number (e.g. "831500" or "831500N" or "831500e")
            if (/^8\d{5}$/.test(cleanDigits)) {
                val = parseInt(cleanDigits);
                matched = true;
                
                // If type not found in current word, look ahead to next word
                if (type === 'Unknown' && i + 1 < words.length) {
                    const nextRaw = words[i+1].text.trim().toUpperCase();
                    if (nextRaw === 'N') type = 'N';
                    else if (nextRaw === 'E') type = 'E';
                }
            } 
            // Pattern 2: Split 3+3 (e.g. "831" then "500")
            else if (/^8\d{2}$/.test(cleanDigits) && i + 1 < words.length) {
                const nextW = words[i+1];
                const nextRaw = nextW.text.trim().toUpperCase();
                const nextClean = nextRaw.replace(/[^0-9]/g, '');
                
                if (/^\d{3}$/.test(nextClean)) {
                    val = parseInt(cleanDigits + nextClean);
                    matched = true;
                    // Merge bounding box
                    bbox = {
                        x0: Math.min(w.bbox.x0, nextW.bbox.x0),
                        y0: Math.min(w.bbox.y0, nextW.bbox.y0),
                        x1: Math.max(w.bbox.x1, nextW.bbox.x1),
                        y1: Math.max(w.bbox.y1, nextW.bbox.y1)
                    };
                    
                    // Check direction in second word (e.g. "500N")
                    if (nextRaw.includes('N')) type = 'N';
                    else if (nextRaw.includes('E')) type = 'E';

                    // If still unknown, check 3rd word (e.g. "831" "500" "N")
                    if (type === 'Unknown' && i + 2 < words.length) {
                        const nextNextRaw = words[i+2].text.trim().toUpperCase();
                        if (nextNextRaw === 'N') type = 'N';
                        else if (nextNextRaw === 'E') type = 'E';
                    }
                }
            }

            if (matched && val >= 800000 && val <= 870000) {
                candidates.push({
                    val,
                    x: (bbox.x0 + bbox.x1) / 2,
                    y: (bbox.y0 + bbox.y1) / 2,
                    type,
                    source
                });
            }
        }
        return candidates;
  };

  // Map Import & Calibration Handlers
  const handleMapImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setLoadingMessage("Importing map...");
    setDetectedMapInfo(null);

    try {
        let blob: Blob = file;
        let imgWidth = 0;
        let imgHeight = 0;
        let formatString = "";
        
        // Convert PDF to Image if needed
        if (file.type === 'application/pdf') {
            setLoadingMessage("Converting PDF (High Res)...");
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
            const page = await pdf.getPage(1); // Render first page
            
            // Check original viewport size (points)
            // A4 is approx 595 x 842 pts
            // A3 is approx 842 x 1190 pts
            const origViewport = page.getViewport({ scale: 1.0 });
            const wPts = origViewport.width;
            const hPts = origViewport.height;
            const minDim = Math.min(wPts, hPts);
            
            if (minDim > 580 && minDim < 610) {
                formatString = "A4";
            } else if (minDim > 820 && minDim < 860) {
                formatString = "A3";
            } else {
                formatString = "Custom";
            }

            // Increase scale to 3.0 for better OCR accuracy
            const viewport = page.getViewport({ scale: 3.0 }); 
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            imgWidth = viewport.width;
            imgHeight = viewport.height;

            await page.render({ canvasContext: context!, viewport: viewport }).promise;
            
            blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
        } else {
            // It's an image, get dims
            const img = await new Promise<HTMLImageElement>(resolve => {
               const i = new Image();
               i.onload = () => resolve(i);
               i.src = URL.createObjectURL(file);
            });
            imgWidth = img.naturalWidth;
            imgHeight = img.naturalHeight;
            formatString = "Custom";
        }

        // Determine Orientation
        const orientation = imgWidth > imgHeight ? 'Landscape' : 'Portrait';
        
        // Simplified detection string as requested
        setDetectedMapInfo(`Detected: ${formatString} ${orientation}`);

        const url = URL.createObjectURL(blob);
        setCalibrationImage(url);
        setCalibrationBlob(blob);
        onImportedMapChange(blob); // Notify parent of imported map
        setPoints([]); // Reset points

        // --- AUTOMATIC DETECTION LOGIC ---
        
        // Initialize Tesseract Worker
        const worker = await createWorker('eng');
        // Whitelist numbers and N/E to allow context detection and handling spaces, include lowercase
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789nNeE', 
        });

        // PASS 1: Horizontal Scan
        setLoadingMessage("Scanning Horizontal Coordinates...");
        const ret = await worker.recognize(url);
        const horizontalCandidates = extractCandidates(ret.data.words || [], 'horizontal');
        
        // Use pre-calculated dimensions
        const width = imgWidth || 2000; 
        const height = imgHeight || 2000;

        // PASS 2: Vertical Scan (Rotate 90 deg)
        // This detects text that runs vertically (e.g. up the side of the page)
        setLoadingMessage("Scanning Vertical Coordinates...");
        
        const img = await new Promise<HTMLImageElement>(resolve => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.src = url;
        });

        const rotCanvas = document.createElement('canvas');
        rotCanvas.width = height; // Swap W/H
        rotCanvas.height = width;
        const rotCtx = rotCanvas.getContext('2d');
        if (rotCtx) {
             rotCtx.translate(height, 0);
             rotCtx.rotate(90 * Math.PI / 180);
             rotCtx.drawImage(img, 0, 0);
        }
        
        const rotUrl = rotCanvas.toDataURL('image/png');
        const retRot = await worker.recognize(rotUrl);
        const verticalCandidatesRaw = extractCandidates(retRot.data.words || [], 'vertical');
        
        // Transform rotated coordinates back to original space
        const verticalCandidates = verticalCandidatesRaw.map(c => ({
            ...c,
            x: c.y,
            y: height - c.x
        }));

        await worker.terminate();

        const candidates = [...horizontalCandidates, ...verticalCandidates];

        // Margin-based classification fallbacks
        const marginThreshold = 0.25; // Relaxed margin threshold

        // Filter and classify
        const eastings = candidates.filter(c => {
            if (c.type === 'E') return true;
            if (c.type === 'N') return false;
            
            // User specified: E coordinates are vertical text (found in vertical scan)
            if (c.source === 'vertical') return true;

            // Fallback: Eastings are labels usually at Top/Bottom
            return c.y < height * marginThreshold || c.y > height * (1 - marginThreshold);
        }).sort((a,b) => a.x - b.x);

        const northings = candidates.filter(c => {
            if (c.type === 'N') return true;
            if (c.type === 'E') return false;

            // User specified: N coordinates are horizontal text (found in horizontal scan)
            if (c.source === 'horizontal') return true;

            // Fallback: Northings are labels usually at Left/Right
            return c.x < width * marginThreshold || c.x > width * (1 - marginThreshold);
        }).sort((a,b) => a.y - b.y);

        // Remove duplicates and close values (spatial & value check)
        const distinctE = eastings.filter((c, i, arr) => {
             if (i === 0) return true;
             // Check dist > 50px OR value diff > 0 (different marker)
             return Math.abs(c.x - arr[i-1].x) > 50 || c.val !== arr[i-1].val;
        });
        const distinctN = northings.filter((c, i, arr) => {
             if (i === 0) return true;
             return Math.abs(c.y - arr[i-1].y) > 50 || c.val !== arr[i-1].val;
        });

        if (distinctE.length >= 2 && distinctN.length >= 2) {
            // E = mX * x + cX
            // Solve using first and last distinct point for max spread
            const e1 = distinctE[0];
            const e2 = distinctE[distinctE.length - 1];
            
            const n1 = distinctN[0];
            const n2 = distinctN[distinctN.length - 1];

            // ScaleX = dE / dx
            const scaleX = (e2.val - e1.val) / (e2.x - e1.x);
            // ScaleY = dN / dy
            const scaleY = (n2.val - n1.val) / (n2.y - n1.y);

            // Origin (0,0 of image)
            const eOrigin = e1.val - (e1.x * scaleX);
            const nOrigin = n1.val - (n1.y * scaleY);

            // Construct Bounds
            const topLeft_HK = { n: nOrigin, e: eOrigin };
            const bottomRight_HK = {
                n: nOrigin + (img.naturalHeight * scaleY),
                e: eOrigin + (img.naturalWidth * scaleX)
            };

            const topLeft_WGS = hk80ToWGS84(topLeft_HK.n, topLeft_HK.e);
            const bottomRight_WGS = hk80ToWGS84(bottomRight_HK.n, bottomRight_HK.e);

            const north = Math.max(topLeft_WGS.latitude, bottomRight_WGS.latitude);
            const south = Math.min(topLeft_WGS.latitude, bottomRight_WGS.latitude);
            const east = Math.max(topLeft_WGS.longitude, bottomRight_WGS.longitude);
            const west = Math.min(topLeft_WGS.longitude, bottomRight_WGS.longitude);
            
            const calibratedBounds: MapBounds = { north, south, east, west };
            
            // Auto Export!
            setLoadingMessage("Coordinates detected! Generating document...");
            const activePhotos = photos.filter(p => !p.isDeleted && !p.isReference); // Filter reference photos from map
            
            // Pass calibrated data to parent immediately
            onImportedMapChange(blob, calibratedBounds);

            // We default to A4 Landscape for auto-export, but user can change later via selection
            await generateMapOverlayDoc(
                activePhotos, 
                calibratedBounds, 
                'A4', 
                'landscape', 
                blob
            );
            
            setCalibrationImage(null); // Clean up
            // Don't open manual modal
        } else {
            // Detection Failed
            alert(`Failed to automatically detect HK1980 coordinates (Found ${distinctE.length} E, ${distinctN.length} N). Please calibrate manually by clicking on two grid intersections.`);
            setIsCalibrating(true);
        }

    } catch (e) {
        console.error("Map import/detection failed", e);
        alert("Failed to process map. Please try manual calibration.");
        setIsCalibrating(true);
    } finally {
        setIsProcessing(false);
        setLoadingMessage("Processing...");
        if (mapImportRef.current) mapImportRef.current.value = '';
    }
  };

  const handleCalibrationClick = (e: React.MouseEvent<HTMLDivElement>) => {
      if (points.length >= 2) return;
      
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Calculate actual image coordinates (scaling from display to intrinsic)
      const img = calibrationImgRef.current;
      if (!img) return;
      
      const scaleX = img.naturalWidth / rect.width;
      const scaleY = img.naturalHeight / rect.height;
      
      setPoints([...points, {
          x: x * scaleX,
          y: y * scaleY,
          north: '',
          east: ''
      }]);
  };

  const updatePoint = (index: number, field: 'north' | 'east', value: string) => {
      const newPoints = [...points];
      newPoints[index] = { ...newPoints[index], [field]: value };
      setPoints(newPoints);
  };

  const finalizeCalibration = async () => {
      if (points.length < 2 || !calibrationBlob || !calibrationImage) return;
      
      // Validate inputs
      const p1 = points[0];
      const p2 = points[1];
      const n1 = parseFloat(p1.north);
      const e1 = parseFloat(p1.east);
      const n2 = parseFloat(p2.north);
      const e2 = parseFloat(p2.east);

      if (isNaN(n1) || isNaN(e1) || isNaN(n2) || isNaN(e2)) {
          alert("Please enter valid numeric coordinates.");
          return;
      }

      setIsExporting(true);
      try {
          // Calculate Image Scale (Meters per Pixel)
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y; // Y increases downwards in pixels
          const dE = e2 - e1;
          const dN = n2 - n1;

          // Scale Factors
          // E = E_origin + x * scaleX
          // N = N_origin + y * scaleY
          // Solving linear eq
          const scaleX = dE / dx;
          const scaleY = dN / dy;

          // Find Origin (0,0 of image) coordinates in HK80
          const eOrigin = e1 - (p1.x * scaleX);
          const nOrigin = n1 - (p1.y * scaleY);

          // Calculate Image Boundaries in HK80
          const img = await new Promise<HTMLImageElement>(resolve => {
               const i = new Image();
               i.onload = () => resolve(i);
               i.src = calibrationImage;
          });

          // Corners
          const topLeft_HK = { n: nOrigin, e: eOrigin };
          const bottomRight_HK = {
               n: nOrigin + (img.naturalHeight * scaleY),
               e: eOrigin + (img.naturalWidth * scaleX)
          };
          
          // Convert Boundaries to WGS84 for the existing export function
          const topLeft_WGS = hk80ToWGS84(topLeft_HK.n, topLeft_HK.e);
          const bottomRight_WGS = hk80ToWGS84(bottomRight_HK.n, bottomRight_HK.e);

          // Construct MapBounds (North, South, East, West)
          // Note: Coordinates might be flipped depending on scaleY sign (usually negative)
          const north = Math.max(topLeft_WGS.latitude, bottomRight_WGS.latitude);
          const south = Math.min(topLeft_WGS.latitude, bottomRight_WGS.latitude);
          const east = Math.max(topLeft_WGS.longitude, bottomRight_WGS.longitude);
          const west = Math.min(topLeft_WGS.longitude, bottomRight_WGS.longitude);

          const calibratedBounds: MapBounds = { north, south, east, west };

          // Notify parent of the calibrated map data
          onImportedMapChange(calibrationBlob, calibratedBounds);

          // Export using existing function
          // Assuming A4 Landscape for now as default for maps
          const activePhotos = photos.filter(p => !p.isDeleted && !p.isReference); // Filter references
          await generateMapOverlayDoc(
              activePhotos, 
              calibratedBounds, 
              'A4', 
              'landscape', 
              calibrationBlob
          );

          setIsCalibrating(false);
          setPoints([]);
          setCalibrationImage(null);

      } catch (err) {
          console.error(err);
          alert("Error during calibration export");
      } finally {
          setIsExporting(false);
      }
  };

  const handleAnalyze = async (photo: PhotoData) => {
    setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, isAnalyzing: true } : p));
    const analysis = await analyzeLocationWithGemini(photo);
    setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, isAnalyzing: false, aiAnalysis: analysis } : p));
  };

  const handleToggleReference = (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      modifyPhotos(prev => {
          const toggledPhotos = prev.map(p => {
              if (p.id === id) {
                  return { ...p, isReference: !p.isReference };
              }
              return p;
          });
          return resequencePhotos(toggledPhotos);
      });
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    modifyPhotos(prev => {
      const markedPhotos = prev.map(p => {
        if (p.id === id) {
          return { ...p, isDeleted: true, originalName: p.name, name: "Deleted photo" };
        }
        return p;
      });
      return resequencePhotos(markedPhotos);
    });
    if (selectedPhotoId === id) onSelectPhoto(null);
  };

  const handleRestore = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    modifyPhotos(prev => {
       const restoredPhotos = prev.map(p => {
         if (p.id === id) {
           return { ...p, isDeleted: false, name: p.originalName || `Photo direction 0` };
         }
         return p;
       });
       return resequencePhotos(restoredPhotos);
    });
  };

  const getExportFileName = () => {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    return `Photo report dated ${day}.${month}.${year}.docx`;
  };

  const handleExport = async (useTemplate: boolean) => {
    const activePhotos = photos.filter(p => !p.isDeleted);
    if (activePhotos.length === 0) return;
    setIsExporting(true);
    
    const fileName = getExportFileName();

    try {
      // Force template usage if specified AND template exists
      if (useTemplate && templateFile) {
        const buffer = await templateFile.arrayBuffer();
        await generateWordFromTemplate(buffer, activePhotos, fileName);
      } else {
        // Standard export flow (ignores template file even if present)
        await generateWordDocument(activePhotos, fileName);
      }
    } catch (error) {
      console.error("Export failed:", error);
      alert("Failed to export Word document. " + (error as Error).message);
    } finally {
      setIsExporting(false);
    }
  };
  
  const handlePdfExport = async () => {
    const activePhotos = photos.filter(p => !p.isDeleted);
    if (activePhotos.length === 0) return;
    setIsExporting(true);
    try {
        await generateCompressedPdf(activePhotos);
    } catch (error) {
        console.error("PDF Export failed:", error);
        alert("Failed to export PDF.");
    } finally {
        setIsExporting(false);
    }
  };

  // Drag Handlers
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      return;
    }
    setDraggedId(id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) return;

    modifyPhotos(prev => {
      const newList = [...prev];
      const oldIndex = newList.findIndex(p => p.id === draggedId);
      const newIndex = newList.findIndex(p => p.id === targetId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const [movedItem] = newList.splice(oldIndex, 1);
      newList.splice(newIndex, 0, movedItem);
      return resequencePhotos(newList);
    });
    setDraggedId(null);
  };

  // Navigation Logic
  const activeList = photos.filter(p => !p.isDeleted);
  const selectedIndex = selectedPhotoId ? activeList.findIndex(p => p.id === selectedPhotoId) : -1;
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex !== -1 && selectedIndex < activeList.length - 1;

  const handlePrevious = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (hasPrevious) onSelectPhoto(activeList[selectedIndex - 1].id);
  };

  const handleNext = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (hasNext) onSelectPhoto(activeList[selectedIndex + 1].id);
  };

  const selectedPhoto = photos.find(p => p.id === selectedPhotoId);
  const activePhotosCount = photos.filter(p => !p.isDeleted).length;

  return (
    <>
    <div className="flex flex-col h-full bg-white border-l border-gray-200 shadow-xl w-full z-10 transition-all duration-300">
      
      <input type="file" ref={fileInputRef} onChange={(e) => handleFileUpload(e, undefined)} multiple accept="image/*" className="hidden"/>
      <input type="file" ref={insertInputRef} onChange={(e) => handleFileUpload(e, undefined)} multiple accept="image/*" className="hidden"/>

      {/* Control Area - Compact */}
      <div className="p-3 shrink-0 space-y-3 border-b border-gray-100 shadow-sm bg-gray-50/50">
        
        {/* Compact Upload Button */}
        <div 
          onClick={() => {
              if(!isProcessing) {
                  setInsertAtIndex(null);
                  insertAtIndexRef.current = null;
                  fileInputRef.current?.click();
              }
          }}
          className={`border-2 border-dashed rounded-lg p-2 flex items-center justify-center gap-2 transition-colors group relative overflow-hidden ${isProcessing ? 'border-indigo-100 bg-indigo-50 cursor-wait' : 'border-indigo-200 cursor-pointer hover:bg-indigo-50 hover:border-indigo-400'}`}
        >
          {isProcessing ? (
             <div className="flex items-center gap-2 text-indigo-500 animate-pulse">
                <LucideLoader2 size={18} className="animate-spin" />
                <span className="text-xs font-medium">{loadingMessage}</span>
             </div>
          ) : (
            <>
              <LucideUpload className="text-indigo-600 group-hover:scale-110 transition-transform" size={18} />
              <p className="text-sm font-semibold text-gray-600">Upload Photos</p>
            </>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-2">
            {/* Mega.io Integration (Import Link Button) */}
            <button 
                onClick={() => setShowMegaModal(true)}
                className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-[10px] font-semibold bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 transition-colors"
                title="Import from Mega"
            >
                <LucideCloud size={12} /> Import Mega
            </button>

             {/* Grid View Button */}
            <button 
                onClick={() => setShowGridModal(true)}
                disabled={activePhotosCount === 0}
                className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-[10px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-colors disabled:opacity-50"
                title="Rearrange Photos in Grid View"
            >
                <LucideGrid size={12} /> Sort / Grid
            </button>
        </div>


        {uploadSuccess && (
            <div className="bg-green-50 border border-green-200 text-green-800 text-xs px-3 py-1.5 rounded-md flex items-center gap-2 animate-fade-in shadow-sm">
                <LucideCheckCircle2 size={14} className="text-green-600"/>
                <span className="font-semibold">Upload Completed!</span>
            </div>
        )}

        {activePhotosCount > 0 && (
          <>
             {/* Action Grid - 2 Columns */}
             <div className="grid grid-cols-2 gap-2">
                <button
                    onClick={() => handleExport(false)} 
                    disabled={isExporting}
                    className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold bg-gray-800 text-white hover:bg-gray-900 shadow-sm transition-colors"
                >
                    {isExporting ? <LucideLoader2 size={14} className="animate-spin" /> : <LucideFileText size={14} />}
                    Export Word
                </button>
                  
                <button
                    onClick={handlePdfExport}
                    disabled={isExporting}
                    className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 shadow-sm transition-colors"
                >
                    {isExporting ? <LucideLoader2 size={14} className="animate-spin" /> : <LucideFileDigit size={14} />}
                    Export PDF
                </button>
             </div>

             {/* Template Section */}
            <div className="border-t border-gray-200 pt-2">
              {!templateFile ? (
                 <button onClick={() => templateInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 py-1.5 px-3 rounded-md text-xs font-medium bg-white text-gray-600 hover:bg-gray-50 border border-gray-300 transition-colors">
                   <LucideFileUp size={14} /> Import Word Template
                 </button>
              ) : (
                <div className="space-y-2">
                    <div className="flex items-center justify-between bg-green-50 px-2 py-1.5 rounded border border-green-100 text-xs">
                        <span className="truncate text-green-700 font-medium max-w-[150px]">{templateFile.name}</span>
                        <button onClick={() => setTemplateFile(null)} className="text-red-500 hover:text-red-700"><LucideX size={14} /></button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            onClick={() => handleExport(true)}
                            disabled={isExporting}
                            className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold bg-green-600 text-white hover:bg-green-700 shadow-sm transition-colors"
                        >
                            {isExporting ? <LucideLoader2 size={14} className="animate-spin" /> : <LucideFileText size={14} />}
                            Exp. Template
                        </button>
                        
                        <button
                            onClick={handlePdfExport}
                            disabled={isExporting}
                            className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 shadow-sm transition-colors"
                        >
                            {isExporting ? <LucideLoader2 size={14} className="animate-spin" /> : <LucideFileDigit size={14} />}
                            Export PDF
                        </button>
                    </div>
                </div>
              )}
              <input type="file" ref={templateInputRef} onChange={handleTemplateUpload} accept=".docx" className="hidden"/>
            </div>

            {/* Custom Map Import */}
            <div className="border-t border-gray-200 pt-2">
                <input type="file" ref={mapImportRef} onChange={handleMapImport} accept="image/*,application/pdf" className="hidden"/>
                <button
                    onClick={() => mapImportRef.current?.click()}
                    disabled={isProcessing}
                    className="w-full flex items-center justify-center gap-2 py-1.5 px-4 rounded-md text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 shadow-sm transition-colors"
                >
                    <LucideMap size={14}/> Import HK1980 Map (PDF/Img)
                </button>
                {calibrationBlob && (
                    <div className="mt-1 text-center">
                        <p className="text-[10px] text-orange-600 font-semibold">Map Imported & Ready</p>
                        {detectedMapInfo && <p className="text-[10px] text-gray-500 leading-tight">{detectedMapInfo}</p>}
                    </div>
                )}
            </div>
            
            {/* Extract Map Layers */}
            <div className="space-y-1.5 border-t border-gray-200 pt-2">
                <div className="flex items-center gap-1 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                     <LucideCrop size={10} />
                     <p>Extract Map Area</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    {[
                        { l: 'A4 Portrait', f: 'A4', o: 'portrait' },
                        { l: 'A4 Landscape', f: 'A4', o: 'landscape' },
                        { l: 'A3 Portrait', f: 'A3', o: 'portrait' },
                        { l: 'A3 Landscape', f: 'A3', o: 'landscape' },
                    ].map((btn) => (
                        <button
                            key={btn.l}
                            onClick={() => window.dispatchEvent(new CustomEvent('init-map-selection', { detail: { format: btn.f, orientation: btn.o } }))}
                            disabled={isExporting}
                            className="flex items-center justify-center py-1 rounded bg-indigo-50 text-indigo-700 text-[10px] font-medium border border-indigo-100 hover:bg-indigo-100 transition-colors"
                        >
                            {btn.l}
                        </button>
                    ))}
                </div>
            </div>
          </>
        )}
      </div>

      {/* Content Area (Photos) */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-4 space-y-4">
        {selectedPhoto && !selectedPhoto.isDeleted ? (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm animate-fade-in">
             <div className="relative h-48 bg-gray-100 group">
                <img src={selectedPhoto.previewUrl} alt={selectedPhoto.name} className="w-full h-full object-cover" />
                
                {/* Back Button */}
                <button onClick={() => onSelectPhoto(null)} className="absolute top-2 left-2 bg-black/50 hover:bg-black/70 text-white px-3 py-1.5 rounded-md text-xs backdrop-blur-sm flex items-center gap-1 transition-colors z-10">← Back</button>
                
                {/* Navigation Buttons */}
                {hasPrevious && (
                    <button 
                        onClick={handlePrevious}
                        className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/60 text-white p-1.5 rounded-full backdrop-blur-sm transition-colors z-10"
                        title="Previous Photo"
                    >
                        <LucideChevronLeft size={24} />
                    </button>
                )}
                
                {hasNext && (
                    <button 
                        onClick={handleNext}
                        className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/60 text-white p-1.5 rounded-full backdrop-blur-sm transition-colors z-10"
                        title="Next Photo"
                    >
                        <LucideChevronRight size={24} />
                    </button>
                )}
             </div>
             <div className="p-4">
                <div className="flex items-center gap-2 mb-2 group/edit">
                    <input value={selectedPhoto.name} onChange={(e) => handleNameChange(selectedPhoto.id, e.target.value)} className="font-bold text-gray-800 text-lg w-full bg-transparent border-b border-transparent focus:border-indigo-500 focus:outline-none py-0.5" />
                    <LucidePen size={14} className="text-gray-400 opacity-0 group-hover/edit:opacity-100" />
                </div>
                
                {selectedPhoto.coordinates && !selectedPhoto.isReference && (
                  <div className="space-y-2 mb-4">
                    <div className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 p-2 rounded border border-gray-100">
                      <LucideMapPin size={16} className="shrink-0 text-gray-400"/>
                      <span className="font-mono text-xs">
                        {selectedPhoto.coordinates.latitude.toFixed(6)}, {selectedPhoto.coordinates.longitude.toFixed(6)}
                      </span>
                    </div>
                  </div>
                )}
                
                <div className="flex justify-between items-center mt-4 pt-4 border-t border-gray-100">
                    <button 
                        onClick={() => handleAnalyze(selectedPhoto)}
                        disabled={selectedPhoto.isAnalyzing || !selectedPhoto.coordinates}
                        className="flex items-center gap-2 text-indigo-600 text-sm font-medium hover:text-indigo-800 transition-colors disabled:opacity-50"
                    >
                        {selectedPhoto.isAnalyzing ? <LucideLoader2 className="animate-spin" size={16}/> : <LucideSparkles size={16}/>}
                        {selectedPhoto.aiAnalysis ? 'Re-Analyze Location' : 'Analyze Location'}
                    </button>
                    <button 
                        onClick={(e) => handleDelete(selectedPhoto.id, e)}
                        className="text-red-500 hover:text-red-700 p-2 rounded-full hover:bg-red-50 transition-colors"
                        title="Delete Photo"
                    >
                        <LucideTrash2 size={18} />
                    </button>
                </div>

                {selectedPhoto.aiAnalysis && (
                  <div className="mt-4 p-3 bg-indigo-50 rounded-lg text-sm text-gray-700 leading-relaxed border border-indigo-100 animate-fade-in">
                    <h4 className="font-semibold text-indigo-900 mb-1 flex items-center gap-2"><LucideSparkles size={14}/> AI Insights</h4>
                    {selectedPhoto.aiAnalysis}
                  </div>
                )}
             </div>
          </div>
        ) : (
          <div className="space-y-3">
             {photos.map((photo, index) => (
                <React.Fragment key={photo.id}>
                    {/* Insert Zone */}
                    <div 
                        className="h-2 -my-1 relative z-10 group cursor-pointer"
                        onClick={() => triggerInsert(index)}
                    >
                        <div className="absolute inset-x-0 top-1/2 h-0.5 bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity"></div>
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-blue-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-sm">
                            <LucidePlusCircle size={14} />
                        </div>
                    </div>

                    <div 
                        draggable={!photo.isDeleted}
                        onDragStart={(e) => !photo.isDeleted && handleDragStart(e, photo.id)}
                        onDragOver={handleDragOver}
                        onDrop={(e) => handleDrop(e, photo.id)}
                        onClick={() => !photo.isDeleted && onSelectPhoto(photo.id)}
                        className={`
                            flex items-center gap-3 p-3 rounded-lg border transition-all duration-200 group relative
                            ${photo.isDeleted 
                                ? 'bg-gray-50 border-gray-100 opacity-60' 
                                : selectedPhotoId === photo.id 
                                    ? 'bg-indigo-50 border-indigo-200 shadow-sm ring-1 ring-indigo-200' 
                                    : photo.isReference
                                        ? 'bg-amber-50 border-amber-200'
                                        : 'bg-white border-gray-100 hover:border-gray-300 hover:shadow-sm'
                            }
                            ${draggedId === photo.id ? 'opacity-40 scale-[0.98]' : ''}
                        `}
                    >
                        {!photo.isDeleted && (
                             <div className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500">
                                 <LucideGripVertical size={16} />
                             </div>
                        )}
                        
                        <div className="w-12 h-12 rounded-md bg-gray-100 shrink-0 overflow-hidden border border-gray-200 relative">
                            <img src={photo.previewUrl} alt="" className="w-full h-full object-cover" />
                            {photo.isReference && (
                                <div className="absolute inset-0 bg-amber-500/20 flex items-center justify-center">
                                    <LucideBookImage size={20} className="text-amber-600 drop-shadow-md" />
                                </div>
                            )}
                        </div>
                        
                        <div className="flex-1 min-w-0">
                            {photo.isReference && !photo.isDeleted ? (
                                <div className="flex flex-col">
                                    <input 
                                        type="text" 
                                        value={photo.name}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => handleNameChange(photo.id, e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                        }}
                                        className="font-medium text-sm text-amber-900 bg-transparent border-b border-dashed border-amber-300 hover:border-amber-500 focus:border-amber-600 focus:outline-none w-full transition-colors pb-0.5"
                                        placeholder="Name this reference..."
                                    />
                                    <span className="text-[10px] font-semibold text-amber-600 uppercase tracking-wider block mt-1">Reference Photo</span>
                                </div>
                            ) : (
                                <>
                                    <h3 className={`font-medium text-sm truncate ${photo.isDeleted ? 'text-gray-500 italic decoration-slate-400 line-through' : 'text-gray-800'}`}>
                                        {photo.name}
                                    </h3>
                                    {photo.isDeleted && (
                                        <span className="text-xs text-red-400 flex items-center gap-1 mt-0.5">Deleted</span>
                                    )}
                                </>
                            )}
                        </div>

                        <div className="flex items-center gap-1">
                            {!photo.isDeleted && (
                                <button
                                    onClick={(e) => handleToggleReference(photo.id, e)}
                                    className={`p-1.5 rounded-full transition-colors opacity-0 group-hover:opacity-100 ${photo.isReference ? 'text-amber-500 bg-amber-100 opacity-100' : 'text-gray-400 hover:text-amber-500 hover:bg-amber-50'}`}
                                    title={photo.isReference ? "Unmark as Reference" : "Mark as Reference Photo"}
                                >
                                    <LucideBookImage size={16} />
                                </button>
                            )}
                            {photo.isDeleted ? (
                                <button 
                                    onClick={(e) => handleRestore(photo.id, e)}
                                    className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-full transition-colors"
                                    title="Restore"
                                >
                                    <LucideUndo size={16} />
                                </button>
                            ) : (
                                <button 
                                    onClick={(e) => handleDelete(photo.id, e)}
                                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors opacity-0 group-hover:opacity-100"
                                    title="Delete"
                                >
                                    <LucideX size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                </React.Fragment>
             ))}
             
             {/* Final Insert Zone */}
             <div 
                className="h-8 relative z-10 group cursor-pointer flex items-center justify-center border-2 border-dashed border-gray-100 rounded-lg hover:border-blue-300 hover:bg-blue-50 transition-all"
                onClick={() => triggerInsert(photos.length)}
            >
                <div className="text-gray-300 group-hover:text-blue-500 flex items-center gap-2 text-sm font-medium">
                    <LucidePlusCircle size={16} /> Insert Photo at End
                </div>
            </div>

             {photos.length === 0 && (
                <div className="text-center py-10 px-4 text-gray-400 border-2 border-dashed border-gray-100 rounded-xl">
                    <LucideImage size={48} className="mx-auto mb-3 opacity-20" />
                    <p className="text-sm">No photos yet.</p>
                    <p className="text-xs mt-1">Upload images to generate your map journal.</p>
                </div>
             )}
          </div>
        )}
      </div>

      {/* Manual Calibration Modal - PORTALED */}
      {isCalibrating && calibrationImage && createPortal(
          <div className="fixed inset-0 z-[1000] bg-black/80 flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
                  <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
                      <div>
                          <h3 className="font-bold text-lg text-gray-800">Calibrate Map Coordinates</h3>
                          <p className="text-sm text-gray-500">Click on two grid intersections and enter their HK1980 coordinates.</p>
                      </div>
                      <button onClick={() => setIsCalibrating(false)} className="text-gray-500 hover:text-gray-700"><LucideX size={24}/></button>
                  </div>
                  
                  <div className="flex-1 overflow-auto relative bg-gray-100 p-4 flex justify-center">
                      <div className="relative inline-block shadow-lg cursor-crosshair">
                          <img 
                              ref={calibrationImgRef}
                              src={calibrationImage} 
                              alt="Calibration" 
                              className="max-w-none"
                              onClick={handleCalibrationClick}
                              style={{ display: 'block' }}
                          />
                          {points.map((p, i) => (
                              <div 
                                  key={i} 
                                  className="absolute w-4 h-4 -ml-2 -mt-2 border-2 border-red-500 rounded-full bg-red-500/20 flex items-center justify-center text-[10px] font-bold text-white pointer-events-none"
                                  style={{ left: p.x / (calibrationImgRef.current?.naturalWidth || 1) * (calibrationImgRef.current?.width || 1), top: p.y / (calibrationImgRef.current?.naturalHeight || 1) * (calibrationImgRef.current?.height || 1) }}
                              >
                                  {i + 1}
                              </div>
                          ))}
                      </div>
                  </div>

                  <div className="p-4 border-t border-gray-200 bg-white space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                          {points.map((p, i) => (
                              <div key={i} className="flex gap-2 items-center bg-gray-50 p-3 rounded-lg border border-gray-200">
                                  <div className="w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center font-bold text-sm shrink-0">{i + 1}</div>
                                  <div className="grid grid-cols-2 gap-2 w-full">
                                      <div>
                                          <label className="text-xs font-semibold text-gray-500 block mb-1">Northing (N)</label>
                                          <input 
                                              type="text" 
                                              placeholder="e.g. 831500"
                                              className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:border-indigo-500 focus:outline-none"
                                              value={p.north}
                                              onChange={(e) => updatePoint(i, 'north', e.target.value)}
                                          />
                                      </div>
                                      <div>
                                          <label className="text-xs font-semibold text-gray-500 block mb-1">Easting (E)</label>
                                          <input 
                                              type="text" 
                                              placeholder="e.g. 817500"
                                              className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:border-indigo-500 focus:outline-none"
                                              value={p.east}
                                              onChange={(e) => updatePoint(i, 'east', e.target.value)}
                                          />
                                      </div>
                                  </div>
                              </div>
                          ))}
                          {points.length < 2 && (
                              <div className="flex items-center justify-center bg-yellow-50 p-3 rounded-lg text-xs text-yellow-700">
                                  Select at least 2 points on the map to proceed.
                              </div>
                          )}
                      </div>
                      
                      <button 
                          onClick={finalizeCalibration}
                          disabled={points.length < 2 || isExporting}
                          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-3 rounded-lg font-bold shadow-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      >
                          {isExporting ? <LucideLoader2 className="animate-spin" size={20}/> : <LucideCheck size={20}/>}
                          {isExporting ? 'Generating...' : 'Calibrate & Export'}
                      </button>
                  </div>
              </div>
          </div>,
          document.body
      )}

      {/* Mega Import Modal - PORTALED */}
      {showMegaModal && createPortal(
          <div className="fixed inset-0 z-[1000] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
              <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden transform transition-all scale-100">
                   <div className="p-4 border-b border-gray-200 bg-red-50 flex items-center justify-between">
                       <h3 className="font-bold text-gray-800 flex items-center gap-2">
                           <LucideCloud className="text-red-600"/> Import from Mega.nz
                       </h3>
                       <button onClick={() => setShowMegaModal(false)} className="text-gray-500 hover:text-gray-700">
                           <LucideX size={20} />
                       </button>
                   </div>
                   
                   <div className="p-6 space-y-4">
                       <p className="text-sm text-gray-600">
                           Paste direct file links from Mega.nz (one per line). Files will be decrypted in browser.
                       </p>
                       <div className="flex justify-end mb-2">
                          <a href="https://mega.io/zh-hant/" target="_blank" rel="noreferrer" className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1">
                             Open Mega.io (zh-hant) <LucideExternalLink size={10}/>
                          </a>
                       </div>
                       
                       <div className="relative">
                           <textarea 
                               value={megaLink}
                               onChange={(e) => setMegaLink(e.target.value)}
                               placeholder={"https://mega.nz/file/...\nhttps://mega.nz/file/..."}
                               className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none text-sm transition-shadow min-h-[120px] resize-y font-mono"
                               disabled={megaLoading}
                           />
                       </div>

                       {megaError && (
                           <div className="bg-red-50 text-red-600 text-xs p-3 rounded-lg border border-red-100 flex items-start gap-2 overflow-auto max-h-32">
                               <LucideX size={14} className="mt-0.5 shrink-0"/>
                               <span className="whitespace-pre-line">{megaError}</span>
                           </div>
                       )}

                       <button 
                           onClick={handleMegaImport}
                           disabled={megaLoading || !megaLink.trim()}
                           className="w-full bg-red-600 hover:bg-red-700 text-white py-2.5 rounded-lg font-semibold shadow-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                       >
                           {megaLoading ? (
                               <>
                                   <LucideLoader2 className="animate-spin" size={18}/> {megaStatus || "Processing..."}
                               </>
                           ) : (
                               <>
                                   <LucideDownload size={18}/> Import Files
                               </>
                           )}
                       </button>
                   </div>
              </div>
          </div>,
          document.body
      )}

      {/* Grid Rearrange Modal - PORTALED (Full Screen) */}
      {showGridModal && createPortal(
          <div className="fixed inset-0 z-[1000] bg-white flex flex-col animate-fade-in">
              <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-gray-50 shrink-0">
                  <div className="flex items-center gap-4">
                      <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                          <LucideGrid className="text-blue-600"/> Rearrange Photos
                      </h2>
                      <div className="flex items-center gap-2">
                        {/* UNDO Button */}
                        <button 
                            onClick={handleUndo} 
                            disabled={history.length === 0}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-200 transition-colors"
                        >
                            <LucideRotateCcw size={16} /> Undo
                        </button>
                        <span className="text-sm text-gray-500 hidden md:inline-block border-l border-gray-300 pl-4">
                           Drag photos to reorder.
                        </span>
                      </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                      <button 
                        onClick={() => {
                            setInsertAtIndex(null);
                            insertAtIndexRef.current = null;
                            fileInputRef.current?.click();
                        }}
                        className="flex items-center gap-2 bg-white text-gray-700 hover:bg-gray-100 border border-gray-300 px-4 py-2 rounded-lg font-semibold transition-colors shadow-sm"
                      >
                         <LucidePlus size={18}/> Add Photos
                      </button>
                      <button 
                          onClick={() => setShowGridModal(false)}
                          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-semibold shadow transition-colors"
                      >
                          Done
                      </button>
                  </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 bg-gray-100">
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 pb-20">
                      {photos.map((photo, index) => {
                          return (
                              <div
                                  key={photo.id}
                                  draggable={!photo.isDeleted}
                                  onDragStart={(e) => !photo.isDeleted && handleDragStart(e, photo.id)}
                                  onDragOver={handleDragOver}
                                  onDrop={(e) => handleDrop(e, photo.id)}
                                  onClick={() => {
                                      if(!photo.isDeleted) {
                                          onSelectPhoto(photo.id);
                                          setShowGridModal(false);
                                      }
                                  }}
                                  className={`
                                      relative group flex flex-col bg-white rounded-xl shadow-sm border-2 transition-all duration-200
                                      ${draggedId === photo.id ? 'opacity-40 border-dashed border-gray-400' : 'hover:shadow-lg'}
                                      ${selectedPhotoId === photo.id ? 'border-blue-500 ring-4 ring-blue-50' : 'border-gray-100 hover:border-blue-200'}
                                      ${photo.isReference ? 'border-amber-300 bg-amber-50' : ''}
                                      ${photo.isDeleted ? 'opacity-60 grayscale border-gray-100 bg-gray-50' : 'cursor-pointer'}
                                  `}
                              >
                                  {/* Insert Button Floating on Left Edge */}
                                  <div 
                                      className="absolute -left-4 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 cursor-pointer z-[50] transition-all hover:scale-110 shadow-md border-2 border-white"
                                      title="Insert Photo Here"
                                      onClick={(e) => {
                                          e.stopPropagation();
                                          triggerInsert(index);
                                      }}
                                  >
                                      <LucidePlus size={18} />
                                  </div>

                                  <div className="relative aspect-[4/3] w-full bg-gray-100 overflow-hidden rounded-t-lg">
                                      <img src={photo.previewUrl} alt={photo.name} className="w-full h-full object-cover" />
                                      
                                      {/* Status Badges */}
                                      <div className="absolute top-2 left-2 flex flex-col gap-1 z-10">
                                           {photo.isReference && !photo.isDeleted && (
                                               <span className="bg-amber-500 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow-sm">REF</span>
                                           )}
                                           {!photo.isReference && !photo.isDeleted && (
                                               <span className="bg-black/60 text-white text-[10px] font-bold px-2 py-0.5 rounded backdrop-blur-sm">#{photo.sequenceNumber}</span>
                                           )}
                                           {photo.isDeleted && (
                                               <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded shadow-sm flex items-center gap-1"><LucideTrash2 size={10}/> DELETED</span>
                                           )}
                                      </div>

                                      {/* Controls Overlay (Always visible on mobile/deleted, hover on desktop) */}
                                      <div className="absolute top-2 right-2 flex flex-col gap-1.5 z-20 transition-opacity duration-200 opacity-0 group-hover:opacity-100">
                                           {!photo.isDeleted && (
                                                <button 
                                                   onClick={(e) => handleToggleReference(photo.id, e)}
                                                   className={`p-2 rounded-full shadow-sm backdrop-blur-md transition-all ${photo.isReference ? 'bg-amber-100 text-amber-600 hover:bg-amber-200' : 'bg-white/90 text-gray-600 hover:text-amber-600 hover:bg-white'}`}
                                                   title={photo.isReference ? "Unset Reference" : "Set as Reference"}
                                                >
                                                    <LucideBookImage size={16} />
                                                </button>
                                           )}
                                           
                                           {photo.isDeleted ? (
                                                <button 
                                                   onClick={(e) => handleRestore(photo.id, e)}
                                                   className="p-2 rounded-full bg-green-100 text-green-700 hover:bg-green-200 shadow-sm transition-all"
                                                   title="Restore Photo"
                                                >
                                                    <LucideUndo size={16} />
                                                </button>
                                           ) : (
                                                <button 
                                                   onClick={(e) => handleDelete(photo.id, e)}
                                                   className="p-2 rounded-full bg-white/90 text-gray-400 hover:text-red-600 hover:bg-red-50 shadow-sm backdrop-blur-md transition-all"
                                                   title="Delete Photo"
                                                >
                                                    <LucideTrash2 size={16} />
                                                </button>
                                           )}
                                      </div>
                                      
                                      {!photo.isDeleted && (
                                          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                                              <LucideGripVertical className="text-white drop-shadow-lg scale-150 opacity-80" />
                                          </div>
                                      )}
                                  </div>
                                  
                                  <div className="p-3">
                                      <input 
                                        value={photo.name}
                                        disabled={photo.isDeleted}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => handleNameChange(photo.id, e.target.value)}
                                        className={`w-full text-sm font-medium bg-transparent border-b border-transparent focus:border-blue-500 focus:outline-none pb-0.5 truncate transition-colors ${photo.isReference ? 'text-amber-900 placeholder-amber-400' : 'text-gray-700'} ${photo.isDeleted ? 'line-through text-gray-400' : ''}`}
                                        placeholder="Photo Name"
                                      />
                                  </div>
                              </div>
                          );
                      })}
                      
                      {/* Empty State / Add More Card */}
                      <div 
                         onClick={() => {
                             setInsertAtIndex(null);
                             insertAtIndexRef.current = null;
                             fileInputRef.current?.click();
                         }}
                         className="flex flex-col items-center justify-center aspect-[4/3] rounded-xl border-2 border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition-all group bg-gray-50/50"
                      >
                          <div className="p-4 rounded-full bg-white shadow-sm mb-3 group-hover:scale-110 transition-transform">
                              <LucidePlus size={24} className="text-gray-400 group-hover:text-blue-500"/>
                          </div>
                          <span className="text-sm font-medium text-gray-500 group-hover:text-blue-600">Add Photos</span>
                      </div>
                  </div>
              </div>
          </div>,
          document.body
      )}
    </div>
    </>
  );
};

export default PhotoSidebar;