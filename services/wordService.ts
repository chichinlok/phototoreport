import { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType, VerticalAlign, PageBreak, ImageRun as DocImageRun, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType } from 'docx';
// @ts-ignore
import saveAs from 'file-saver';

// @ts-ignore
import PizZip from 'pizzip';

import { PhotoData, MapBounds, MarkerLayout } from '../types';

// Helper: Compress Image to ~1MB limit (Max 1920px, JPEG 0.7)
const compressImage = async (file: File | Blob): Promise<Blob> => {
    try {
        const TARGET_SIZE = 1024 * 1024; // 1MB
        // If it's already small enough and is a JPEG, return as is
        if (file.size <= TARGET_SIZE && (file.type === 'image/jpeg' || file.type === 'image/jpg')) {
             return file;
        }
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            
            img.onload = () => {
                URL.revokeObjectURL(url);
                
                let width = img.width;
                let height = img.height;
                const MAX_DIM = 1920; 
                
                // Resize if too large
                if (width > MAX_DIM || height > MAX_DIM) {
                    const aspect = width / height;
                    if (width > height) {
                        width = MAX_DIM;
                        height = width / aspect;
                    } else {
                        height = MAX_DIM;
                        width = height * aspect;
                    }
                }
                
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if(!ctx) {
                    resolve(file); // Fallback to original if context fails
                    return;
                }
                
                ctx.drawImage(img, 0, 0, width, height);
                
                // 0.7 quality usually results in good looking images under 1MB for this resolution
                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else resolve(file);
                }, 'image/jpeg', 0.7);
            };
            
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(file); // Fallback
            };
            
            img.src = url;
        });
    } catch (e) {
        console.warn("Compression error, using original", e);
        return file;
    }
};

// --- STANDARD DOC EXPORT ---

export const generateWordFromTemplate = async (
  templateBuffer: ArrayBuffer, 
  photos: PhotoData[],
  fileName: string = "GeoPhoto_Mapped.docx"
) => {
  try {
    const zip = new PizZip(templateBuffer);
    const docXmlStr = zip.file("word/document.xml")?.asText();
    
    if (!docXmlStr) {
      throw new Error("Invalid DOCX template: Could not find document.xml");
    }

    // Parse XML
    const parser = new DOMParser();
    const doc = parser.parseFromString(docXmlStr, "application/xml");
    
    // Check for parse errors
    const parseError = doc.getElementsByTagName("parsererror");
    if (parseError.length > 0) {
      throw new Error("Error parsing XML template. The file might be corrupted.");
    }

    // Helper: Find all paragraphs that contain the marker text
    const allParagraphs = Array.from(doc.getElementsByTagName("w:p"));
    const placeholderParagraphs = allParagraphs.filter(p => 
      (p.textContent || "").toLowerCase().includes("photo location")
    );

    if (placeholderParagraphs.length === 0) {
      throw new Error("Could not find text 'photo location' in the template. Please ensure it is typed clearly in the body.");
    }

    const body = doc.getElementsByTagName("w:body")[0];
    if (!body) throw new Error("Invalid Template: No body found");

    let sectPr = body.lastElementChild;
    if (sectPr && sectPr.nodeName !== "w:sectPr") {
       const sects = Array.from(body.childNodes).filter(n => n.nodeName === "w:sectPr");
       sectPr = sects.length > 0 ? sects[sects.length - 1] as Element : null;
    }

    const templateNodes: Node[] = [];
    for (let i = 0; i < body.childNodes.length; i++) {
       const node = body.childNodes[i];
       if (node !== sectPr) {
           templateNodes.push(node);
       }
    }

    // Use passed photos array which preserves user order (including reference photos)
    const activePhotos = photos.filter(p => !p.isDeleted);
    
    const slotsPerPage = placeholderParagraphs.length;
    const totalPhotos = activePhotos.length;
    const totalPages = Math.ceil(totalPhotos / slotsPerPage);

    while (body.firstChild) {
       body.removeChild(body.firstChild);
    }

    const allNewPlaceholders: Element[] = [];

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
        if (pageIndex > 0) {
            const brP = doc.createElement("w:p");
            const brR = doc.createElement("w:r");
            const br = doc.createElement("w:br");
            br.setAttribute("w:type", "page");
            brR.appendChild(br);
            brP.appendChild(brR);
            body.appendChild(brP);
        }

        templateNodes.forEach(node => {
            const clone = node.cloneNode(true) as Element;
            body.appendChild(clone);

            if (clone.nodeName === "w:p") {
                if ((clone.textContent || "").toLowerCase().includes("photo location")) {
                    allNewPlaceholders.push(clone);
                }
            } else if (clone.getElementsByTagName) {
                const nestedParas = Array.from(clone.getElementsByTagName("w:p"));
                nestedParas.forEach(p => {
                    if ((p.textContent || "").toLowerCase().includes("photo location")) {
                        allNewPlaceholders.push(p);
                    }
                });
            }
        });
    }

    if (sectPr) {
        body.appendChild(sectPr);
    }

    let relsXmlStr = zip.file("word/_rels/document.xml.rels")?.asText() || "";
    if (!relsXmlStr) {
        relsXmlStr = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    }
    
    const relsParser = new DOMParser();
    const relsDoc = relsParser.parseFromString(relsXmlStr, "application/xml");
    const relationships = relsDoc.getElementsByTagName("Relationships")[0];

    let maxId = 0;
    Array.from(relationships.getElementsByTagName("Relationship")).forEach(rel => {
        const id = rel.getAttribute("Id");
        if (id && id.startsWith("rId")) {
            const num = parseInt(id.substring(3));
            if (!isNaN(num)) maxId = Math.max(maxId, num);
        }
    });

    let contentTypesXml = zip.file("[Content_Types].xml")?.asText() || "";
    let typesChanged = false;
    if (!contentTypesXml.includes('Extension="png"')) {
        contentTypesXml = contentTypesXml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
        typesChanged = true;
    }
    if (!contentTypesXml.includes('Extension="jpeg"')) {
        contentTypesXml = contentTypesXml.replace('</Types>', '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
        contentTypesXml = contentTypesXml.replace('</Types>', '<Default Extension="jpg" ContentType="image/jpeg"/></Types>');
        typesChanged = true;
    }
    if (typesChanged) zip.file("[Content_Types].xml", contentTypesXml);

    // IMPORTANT: Do NOT sort by sequenceNumber here, rely on list order to handle interleaved reference photos
    const sortedPhotos = [...activePhotos];

    for (let i = 0; i < allNewPlaceholders.length; i++) {
        const p = allNewPlaceholders[i];
        
        let pPr = Array.from(p.childNodes).find(n => n.nodeName === "w:pPr") as Element;
        if (!pPr) {
            pPr = doc.createElement("w:pPr");
            if (p.firstChild) {
                p.insertBefore(pPr, p.firstChild);
            } else {
                p.appendChild(pPr);
            }
        }
        let jc = Array.from(pPr.childNodes).find(n => n.nodeName === "w:jc") as Element;
        if (!jc) {
            jc = doc.createElement("w:jc");
            pPr.appendChild(jc);
        }
        jc.setAttribute("w:val", "center");

        let savedRPrXml = "";
        const runs = Array.from(p.getElementsByTagName("w:r"));
        for (const run of runs) {
             if ((run.textContent || "").toLowerCase().includes("photo location")) {
                 const rPr = Array.from(run.childNodes).find(n => n.nodeName === "w:rPr");
                 if (rPr) {
                     savedRPrXml = new XMLSerializer().serializeToString(rPr);
                     break;
                 }
             }
        }
        if (!savedRPrXml && runs.length > 0) {
             const rPr = Array.from(runs[0].childNodes).find(n => n.nodeName === "w:rPr");
             if (rPr) savedRPrXml = new XMLSerializer().serializeToString(rPr);
        }

        const childNodes = Array.from(p.childNodes);
        for (const node of childNodes) {
            if (node.nodeName !== "w:pPr") {
                p.removeChild(node);
            }
        }

        if (i < sortedPhotos.length) {
            const photo = sortedPhotos[i];
            const rId = `rId${++maxId}`;
            const imgFileName = `media/image_${photo.id}.jpg`; // Use jpg for compressed
            
            // COMPRESS IMAGE
            const compressedBlob = await compressImage(photo.file);
            const imgData = await compressedBlob.arrayBuffer();
            
            zip.file(`word/${imgFileName}`, imgData);

            const newRel = relsDoc.createElement("Relationship");
            newRel.setAttribute("Id", rId);
            newRel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
            newRel.setAttribute("Target", imgFileName);
            relationships.appendChild(newRel);
            
            let widthPx = 250; 
            
            let parent = p.parentNode;
            let foundWidth = false;
            while(parent && parent.nodeName !== 'w:body' && !foundWidth) {
                if (parent.nodeName === 'w:tc') {
                    const tcPr = (parent as Element).getElementsByTagName("w:tcPr")[0];
                    if (tcPr) {
                        const tcW = tcPr.getElementsByTagName("w:tcW")[0];
                        if (tcW) {
                            const wVal = parseInt(tcW.getAttribute("w:w") || "0");
                            const wType = tcW.getAttribute("w:type");
                            if (wType === "dxa" && wVal > 0) {
                                widthPx = (wVal / 15) * 0.70; 
                                foundWidth = true;
                            }
                        }
                    }
                }
                parent = parent.parentNode;
            }

            let heightPx = widthPx;
            try {
                // Use createImageBitmap to get dimensions of the COMPRESSED image
                const bitmap = await createImageBitmap(compressedBlob);
                const aspect = bitmap.height / bitmap.width;
                heightPx = widthPx * aspect;

                const MAX_HEIGHT_PX = 320; 
                if (heightPx > MAX_HEIGHT_PX) {
                    const scale = MAX_HEIGHT_PX / heightPx;
                    widthPx = widthPx * scale;
                    heightPx = MAX_HEIGHT_PX;
                }
            } catch (e) {
                console.warn("Could not determine image dimensions, using calculated default.");
            }

            const widthEmus = Math.round(widthPx * 9525);
            const heightEmus = Math.round(heightPx * 9525);

            const drawingXml = `
            <w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
                 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
                 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
                 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
              <w:drawing>
                <wp:inline distT="0" distB="0" distL="0" distR="0">
                  <wp:extent cx="${widthEmus}" cy="${heightEmus}"/>
                  <wp:effectExtent l="0" t="0" r="0" b="0"/>
                  <wp:docPr id="${maxId}" name="Picture ${maxId}"/>
                  <wp:cNvGraphicFramePr>
                    <a:graphicFrameLocks noChangeAspect="1"/>
                  </wp:cNvGraphicFramePr>
                  <a:graphic>
                    <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                      <pic:pic>
                        <pic:nvPicPr>
                          <pic:cNvPr id="${maxId}" name="${photo.name}"/>
                          <pic:cNvPicPr/>
                        </pic:nvPicPr>
                        <pic:blipFill>
                          <a:blip r:embed="${rId}"/>
                          <a:stretch>
                            <a:fillRect/>
                          </a:stretch>
                        </pic:blipFill>
                        <pic:spPr>
                          <a:xfrm>
                            <a:off x="0" y="0"/>
                            <a:ext cx="${widthEmus}" cy="${heightEmus}"/>
                          </a:xfrm>
                          <a:prstGeom prst="rect">
                            <a:avLst/>
                          </a:prstGeom>
                        </pic:spPr>
                      </pic:pic>
                    </a:graphicData>
                  </a:graphic>
                </wp:inline>
              </w:drawing>
            </w:r>`;

            const drawParser = new DOMParser();
            const drawDoc = drawParser.parseFromString(drawingXml, "application/xml");
            if (drawDoc.documentElement && drawDoc.getElementsByTagName("parsererror").length === 0) {
                 const importedDrawing = doc.importNode(drawDoc.documentElement, true);
                 p.appendChild(importedDrawing);
            }

            const escapedName = photo.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const textXml = `
            <w:r xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
                ${savedRPrXml}
                <w:br/>
                <w:t>${escapedName}</w:t>
            </w:r>`;
            
            const textParser = new DOMParser();
            const textDoc = textParser.parseFromString(textXml, "application/xml");
            if (textDoc.documentElement && textDoc.getElementsByTagName("parsererror").length === 0) {
                 const importedText = doc.importNode(textDoc.documentElement, true);
                 p.appendChild(importedText);
            }
        }
    }

    const serializer = new XMLSerializer();
    const newDocXml = serializer.serializeToString(doc);
    const newRelsXml = serializer.serializeToString(relsDoc);

    zip.file("word/document.xml", newDocXml);
    zip.file("word/_rels/document.xml.rels", newRelsXml);

    const out = zip.generate({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    saveAs(out, fileName);

  } catch (error) {
    console.error("Template generation error:", error);
    throw error;
  }
};

export const generateWordDocument = async (
    photos: PhotoData[],
    fileName: string = "Photo_Journal.docx"
) => {
  const activePhotos = photos.filter(p => !p.isDeleted);
  // Do NOT sort by sequenceNumber, keep list order for reference photos
  const sortedPhotos = [...activePhotos];

  const MAX_WIDTH_PX = 491;
  const MAX_HEIGHT_PX = 378;

  const children: (Paragraph | Table)[] = [];

  for (let i = 0; i < sortedPhotos.length; i += 2) {
      if (i > 0) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }

      const pagePhotos = sortedPhotos.slice(i, i + 2);
      
      for (const photo of pagePhotos) {
          // COMPRESS IMAGE
          const compressedBlob = await compressImage(photo.file);
          const buffer = await compressedBlob.arrayBuffer();
          
          let width = MAX_WIDTH_PX;
          let height = MAX_HEIGHT_PX;

          try {
             // Get dim from compressed blob
             const bitmap = await createImageBitmap(compressedBlob);
             const aspect = bitmap.width / bitmap.height;
             const heightAtMaxWidth = MAX_WIDTH_PX / aspect;
             
             if (heightAtMaxWidth <= MAX_HEIGHT_PX) {
                width = MAX_WIDTH_PX;
                height = heightAtMaxWidth;
             } else {
                height = MAX_HEIGHT_PX;
                width = MAX_HEIGHT_PX * aspect;
             }
          } catch (e) {
              console.warn("Could not determine aspect ratio, using max dimensions.");
          }

          children.push(new Paragraph({
             children: [
                new ImageRun({
                   data: buffer,
                   transformation: { width, height },
                   type: 'jpg', 
                })
             ],
             alignment: AlignmentType.CENTER,
             spacing: { before: 200, after: 100 },
          }));

          children.push(new Paragraph({
             children: [
                 new TextRun({
                     text: photo.name,
                     bold: true,
                     size: 24, 
                     font: "Arial",
                 })
             ],
             alignment: AlignmentType.CENTER,
             spacing: { after: 400 },
          }));
      }
  }

  const doc = new Document({
    sections: [
      {
        properties: {
             page: {
                 margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 }
             }
        },
        children: children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, fileName);
};

// --- MAP OVERLAY GENERATION LOGIC ---

// Helper types for collision logic
interface Point { x: number; y: number; }
interface LabelItem { x: number; y: number; r: number; }
interface PlacedItem { label: LabelItem; anchor: Point; }
interface ImageResult {
    blob: Blob;
    width: number;
    height: number;
    anchorX: number;
    anchorY: number;
}

const dist2 = (v: Point, w: Point) => (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
const distToSegmentSquared = (p: Point, v: Point, w: Point) => {
  const l2 = dist2(v, w);
  if (l2 === 0) return dist2(p, v);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
};
const segmentsIntersect = (p0: Point, p1: Point, p2: Point, p3: Point): boolean => {
  const s1_x = p1.x - p0.x;
  const s1_y = p1.y - p0.y;
  const s2_x = p3.x - p2.x;
  const s2_y = p3.y - p2.y;
  const denom = -s2_x * s1_y + s1_x * s2_y;
  if (denom === 0) return false;
  const s = (-s1_y * (p0.x - p2.x) + s1_x * (p0.y - p2.y)) / denom;
  const t = ( s2_x * (p0.y - p2.y) - s2_y * (p0.x - p2.x)) / denom;
  return (s >= 0.05 && s <= 0.95 && t >= 0.05 && t <= 0.95);
};
const isColliding = (cLabel: LabelItem, cAnchor: Point, existingItems: PlacedItem[]): boolean => {
  const PADDING = 5; 
  for (const item of existingItems) {
    const dx = cLabel.x - item.label.x;
    const dy = cLabel.y - item.label.y;
    const distSq = dx * dx + dy * dy;
    const minDesc = (cLabel.r + item.label.r + PADDING);
    if (distSq < minDesc * minDesc) return true;
    if (distToSegmentSquared({ x: item.label.x, y: item.label.y }, cAnchor, { x: cLabel.x, y: cLabel.y }) < (item.label.r + 5) ** 2) return true;
    if (distToSegmentSquared({ x: cLabel.x, y: cLabel.y }, item.anchor, { x: item.label.x, y: item.label.y }) < (cLabel.r + 5) ** 2) return true;
    if (segmentsIntersect(cAnchor, { x: cLabel.x, y: cLabel.y }, item.anchor, { x: item.label.x, y: item.label.y })) return true;
  }
  return false;
};

// --- CANVAS HELPER FOR FULL MARKER IMAGE GENERATION ---

const createFullMarkerPng = async (len: number, angle: number, number: number, showCircle: boolean, color: string = '#3B82F6'): Promise<ImageResult> => {
    // Geometry Constants
    const headLen = 18;
    const headWidth = 24;
    const radius = 20;
    const PAD = 4; // Pixel padding around the drawn content

    // Rotation Angle in Radians (Clockwise for Canvas)
    // Add 180 degrees (PI) because Map screen points South-base, Word needs North-base alignment
    const rad = ((angle + 180) * Math.PI) / 180;
    
    // Define key points in unrotated local space (Origin 0,0 is Tip)
    // "Unrotated" here draws downwards (South) in canvas coords
    const pTip = { x: 0, y: 0 };
    const pBaseL = { x: -headWidth / 2, y: headLen };
    const pBaseR = { x: headWidth / 2, y: headLen };
    const circleCenterY = headLen + len + radius;
    const pCircleCenter = { x: 0, y: circleCenterY };

    // Rotate a point
    const rotatePt = (p: {x: number, y: number}) => {
       return {
           x: p.x * Math.cos(rad) - p.y * Math.sin(rad),
           y: p.x * Math.sin(rad) + p.y * Math.cos(rad)
       };
    };

    // Transform all key geometry points
    const rTip = rotatePt(pTip);
    const rBaseL = rotatePt(pBaseL);
    const rBaseR = rotatePt(pBaseR);
    const rCircleCenter = rotatePt(pCircleCenter);

    // Calculate Bounding Box
    // Include Arrow Head points
    let minX = Math.min(rTip.x, rBaseL.x, rBaseR.x);
    let maxX = Math.max(rTip.x, rBaseL.x, rBaseR.x);
    let minY = Math.min(rTip.y, rBaseL.y, rBaseR.y);
    let maxY = Math.max(rTip.y, rBaseL.y, rBaseR.y);

    // Include Circle (Center +/- Radius)
    minX = Math.min(minX, rCircleCenter.x - radius);
    maxX = Math.max(maxX, rCircleCenter.x + radius);
    minY = Math.min(minY, rCircleCenter.y - radius);
    maxY = Math.max(maxY, rCircleCenter.y + radius);

    // Dimensions of the bounding box
    const width = Math.ceil(maxX - minX + PAD);
    const height = Math.ceil(maxY - minY + PAD);

    // Anchor Point inside the new canvas (Offset to 0,0 of bounding box)
    // We want Tip (0,0) to be at (anchorX, anchorY) in the new canvas
    const anchorX = -minX + PAD/2;
    const anchorY = -minY + PAD/2;

    // Create Canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("No context");

    // Setup Transform
    ctx.translate(anchorX, anchorY);
    ctx.rotate(rad);

    // Draw (Same Logic as before, local coords)
    // Arrow Head
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.moveTo(0, 0);
    ctx.lineTo(-headWidth/2, headLen);
    ctx.lineTo(headWidth/2, headLen);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.moveTo(0, headLen);
    ctx.lineTo(0, headLen + len);
    ctx.stroke();

    // Circle
    if (showCircle) {
        ctx.beginPath();
        ctx.arc(0, circleCenterY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.stroke();
    }

    // Text - Must be upright relative to PAGE (Canvas), not rotated with shape
    // We need to draw text at the calculated circle center in identity transform
    // Undo rotation for text drawing
    ctx.rotate(-rad); // Rotate back
    
    // But we are still translated to (anchorX, anchorY).
    // We need to find where the circle center is relative to (anchorX, anchorY)
    // rCircleCenter is the offset from Tip(0,0) after rotation.
    // So position is (rCircleCenter.x, rCircleCenter.y) in the translated space.
    
    ctx.font = 'bold 24px Arial';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(number.toString(), rCircleCenter.x, rCircleCenter.y);

    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));

    return {
        blob,
        width,
        height,
        anchorX,
        anchorY
    };
};

const generateMarkerPngXml = (
    id: number, 
    xPt: number, 
    yPt: number, 
    relId: string, 
    widthPx: number,
    heightPx: number,
    anchorXPx: number,
    anchorYPx: number
) => {
    const EMU_PER_PT = 12700;
    const EMU_PER_PX = 9525;
    
    const widthEmus = Math.round(widthPx * EMU_PER_PX);
    const heightEmus = Math.round(heightPx * EMU_PER_PX);
    
    // Map Point on Page
    const pageX_EMU = Math.round(xPt * EMU_PER_PT);
    const pageY_EMU = Math.round(yPt * EMU_PER_PT);
    
    // Top-Left of Image = MapPoint - AnchorOffset
    const left_EMU = pageX_EMU - Math.round(anchorXPx * EMU_PER_PX);
    const top_EMU = pageY_EMU - Math.round(anchorYPx * EMU_PER_PX);

    const docPrId = 5000 + id;

    return `
      <w:r>
        <w:drawing>
          <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="0" allowOverlap="1" wp14:anchorId="${docPrId.toString(16)}">
            <wp:simplePos x="0" y="0"/>
            <wp:positionH relativeFrom="page">
              <wp:posOffset>${left_EMU}</wp:posOffset>
            </wp:positionH>
            <wp:positionV relativeFrom="page">
              <wp:posOffset>${top_EMU}</wp:posOffset>
            </wp:positionV>
            <wp:extent cx="${widthEmus}" cy="${heightEmus}"/>
            <wp:effectExtent l="0" t="0" r="0" b="0"/>
            <wp:wrapNone/>
            <wp:docPr id="${docPrId}" name="Marker ${id}"/>
            <wp:cNvGraphicFramePr>
               <a:graphicFrameLocks noChangeAspect="1"/>
            </wp:cNvGraphicFramePr>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:nvPicPr>
                    <pic:cNvPr id="${docPrId}" name="Marker ${id}"/>
                    <pic:cNvPicPr/>
                  </pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip r:embed="${relId}"/>
                    <a:stretch><a:fillRect/></a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm>
                      <a:off x="0" y="0"/>
                      <a:ext cx="${widthEmus}" cy="${heightEmus}"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:anchor>
        </w:drawing>
      </w:r>`;
};

export const generateMapOverlayDoc = async (
    photos: PhotoData[], 
    bounds: MapBounds, 
    format: 'A4' | 'A3', 
    orientation: 'portrait' | 'landscape',
    mapImage: Blob | null = null,
    markerLayout?: MarkerLayout,
    showCircle: boolean = true,
    markerColor: string = '#3B82F6'
) => {
    // 1. Page Calculation
    const A4_W_MM = 210; const A4_H_MM = 297;
    const A3_W_MM = 297; const A3_H_MM = 420;

    let wMM = format === 'A4' ? A4_W_MM : A3_W_MM;
    let hMM = format === 'A4' ? A4_H_MM : A3_H_MM;

    if (orientation === 'landscape') {
        [wMM, hMM] = [hMM, wMM];
    }

    const wPt = Math.round(wMM * 2.83465);
    const hPt = Math.round(hMM * 2.83465);

    // Coordinate Mapping
    const latSpan = bounds.north - bounds.south;
    const lonSpan = bounds.east - bounds.west;

    const toPagePt = (lat: number, lon: number): Point => {
        const x = ((lon - bounds.west) / lonSpan) * wPt;
        const y = ((bounds.north - lat) / latSpan) * hPt;
        return { x, y };
    };

    // 2. Layout & Collision
    // Ensure we only process photos that have coordinates.
    // NOTE: Photos passed here should already be filtered (no deleted, no references) by caller.
    const sortedPhotos = [...photos].sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
    const headLen = 18; 
    const radius = 20; 
    const minLineLen = 40;
    const maxLenAttempts = 8;
    const lenStep = 10;
    const maxAngleDev = 5;
    const angleStep = 2;

    const placedItems: PlacedItem[] = [];
    const markers: Array<{ id: number, pt: Point, len: number, angle: number, num: number }> = [];

    for (let i = 0; i < sortedPhotos.length; i++) {
        const photo = sortedPhotos[i];
        if (!photo.coordinates) continue;
        const pt = toPagePt(photo.coordinates.latitude, photo.coordinates.longitude);
        // Relax bounding check slightly
        if (pt.x < -200 || pt.x > wPt + 200 || pt.y < -200 || pt.y > hPt + 200) continue;

        let bestLen = minLineLen;
        let bestAngle = (photo.coordinates.heading ?? 0 + 180) % 360;

        // If marker layout is provided from screen, use it exactly
        if (markerLayout && markerLayout[photo.id]) {
             bestLen = markerLayout[photo.id].len;
             bestAngle = markerLayout[photo.id].angle;
        } else {
            // Fallback to re-calculation if layout missing
            const rawHeading = photo.coordinates.heading ?? 0;
            const baseHeading = (rawHeading + 180) % 360; 

            bestAngle = baseHeading;
            
            outerLoop:
            for (let l = 0; l < maxLenAttempts; l++) {
                const currentLen = minLineLen + (l * lenStep);
                for (let a = 0; a <= maxAngleDev; a += angleStep) {
                    const deviations = a === 0 ? [0] : [a, -a];
                    for (const dev of deviations) {
                        const testAngle = baseHeading + dev;
                        const rad = (testAngle * Math.PI) / 180;
                        const lx = pt.x + (headLen + currentLen + radius) * Math.sin(rad);
                        const ly = pt.y - (headLen + currentLen + radius) * Math.cos(rad);

                        const cLabel = { x: lx, y: ly, r: radius };

                        if (!isColliding(cLabel, pt, placedItems)) {
                            bestLen = currentLen;
                            bestAngle = testAngle;
                            break outerLoop;
                        }
                    }
                }
            }
        }

        const rad = (bestAngle * Math.PI) / 180;
        const totalDist = headLen + bestLen + radius;
        placedItems.push({
            anchor: pt,
            label: {
                x: pt.x + totalDist * Math.sin(rad),
                y: pt.y - totalDist * Math.cos(rad),
                r: radius
            }
        });
        markers.push({
            id: i + 1,
            pt,
            len: bestLen,
            angle: bestAngle,
            num: photo.sequenceNumber || 0
        });
    }

    // 3. Create Base Doc
    const doc = new Document({
        sections: [{
            properties: {
                page: {
                    size: { width: wPt * 20, height: hPt * 20 },
                    margin: { top: 0, bottom: 0, left: 0, right: 0 }
                }
            },
            children: [new Paragraph({ children: [new TextRun("{{MARKERS_XML}}")] })]
        }]
    });

    // 4. PizZip & Image Prep
    const initialBlob = await Packer.toBlob(doc);
    const arrayBuffer = await initialBlob.arrayBuffer();
    const zip = new PizZip(arrayBuffer);

    // Prepare Rels
    let relsXmlStr = zip.file("word/_rels/document.xml.rels")?.asText() || 
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
    const relsParser = new DOMParser();
    const relsDoc = relsParser.parseFromString(relsXmlStr, "application/xml");
    const relationships = relsDoc.getElementsByTagName("Relationships")[0];
    let maxId = 0;
    Array.from(relationships.getElementsByTagName("Relationship")).forEach(rel => {
        const id = rel.getAttribute("Id");
        if (id && id.startsWith("rId")) {
            const num = parseInt(id.substring(3));
            if (!isNaN(num)) maxId = Math.max(maxId, num);
        }
    });

    // Update Content Types for PNG
    let contentTypesXml = zip.file("[Content_Types].xml")?.asText() || "";
    if (!contentTypesXml.includes('Extension="png"')) {
        contentTypesXml = contentTypesXml.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>');
        zip.file("[Content_Types].xml", contentTypesXml);
    }

    // --- LAYER 1: MAP BACKGROUND ---
    let outputXmlString = "";
    if (mapImage) {
        const mapRelId = `rId${++maxId}`;
        zip.file("word/media/map_background.png", await mapImage.arrayBuffer());

        const mapRel = relsDoc.createElement("Relationship");
        mapRel.setAttribute("Id", mapRelId);
        mapRel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
        mapRel.setAttribute("Target", "media/map_background.png");
        relationships.appendChild(mapRel);

        const pageW_EMU = Math.round(wPt * 12700);
        const pageH_EMU = Math.round(hPt * 12700);
        const docPrId = 999;

        // Insert as simple picture behind text (behindDoc=1)
        outputXmlString += `
        <w:r>
          <w:drawing>
             <wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="0" layoutInCell="0" allowOverlap="1" wp14:anchorId="10000000">
                <wp:simplePos x="0" y="0"/>
                <wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH>
                <wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV>
                <wp:extent cx="${pageW_EMU}" cy="${pageH_EMU}"/>
                <wp:effectExtent l="0" t="0" r="0" b="0"/>
                <wp:wrapNone/>
                <wp:docPr id="${docPrId}" name="Map Background"/>
                <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="0"/></wp:cNvGraphicFramePr>
                <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
                   <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                      <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                         <pic:nvPicPr>
                            <pic:cNvPr id="${docPrId}" name="Map Background"/>
                            <pic:cNvPicPr/>
                         </pic:nvPicPr>
                         <pic:blipFill>
                            <a:blip r:embed="${mapRelId}"/>
                            <a:stretch><a:fillRect/></a:stretch>
                         </pic:blipFill>
                         <pic:spPr>
                            <a:xfrm>
                               <a:off x="0" y="0"/>
                               <a:ext cx="${pageW_EMU}" cy="${pageH_EMU}"/>
                            </a:xfrm>
                            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                         </pic:spPr>
                      </pic:pic>
                   </a:graphicData>
                </a:graphic>
             </wp:anchor>
          </w:drawing>
        </w:r>
        `;
    }

    // --- LAYER 2+: MARKER IMAGES ---
    for (const m of markers) {
        // Create One Full Image for the marker (Layer)
        const result = await createFullMarkerPng(m.len, m.angle, m.num, showCircle, markerColor);
        const markerRelId = `rId${++maxId}`;
        const markerFileName = `media/marker_${m.id}.png`;
        zip.file(`word/${markerFileName}`, await result.blob.arrayBuffer());

        const markerRel = relsDoc.createElement("Relationship");
        markerRel.setAttribute("Id", markerRelId);
        markerRel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image");
        markerRel.setAttribute("Target", markerFileName);
        relationships.appendChild(markerRel);
        
        outputXmlString += generateMarkerPngXml(m.id, m.pt.x, m.pt.y, markerRelId, result.width, result.height, result.anchorX, result.anchorY);
    }

    // Save Rels
    const serializer = new XMLSerializer();
    zip.file("word/_rels/document.xml.rels", serializer.serializeToString(relsDoc));

    // Inject XML
    let docXml = zip.file("word/document.xml")?.asText();
    if (docXml) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(docXml, "application/xml");
        
        // Ensure namespaces
        const wDoc = xmlDoc.getElementsByTagName("w:document")[0];
        if (wDoc) {
             wDoc.setAttribute("xmlns:wp14", "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing");
             wDoc.setAttribute("xmlns:pic", "http://schemas.openxmlformats.org/drawingml/2006/picture");
        }

        const ps = xmlDoc.getElementsByTagName("w:p");
        for (let i = 0; i < ps.length; i++) {
            if (ps[i].textContent?.includes("{{MARKERS_XML}}")) {
                while (ps[i].firstChild) ps[i].removeChild(ps[i].firstChild);
                
                // Wrap in root to parse
                const wrapper = `<root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing">${outputXmlString}</root>`;
                const fragDoc = parser.parseFromString(wrapper, "application/xml");
                Array.from(fragDoc.documentElement.childNodes).forEach(r => ps[i].appendChild(xmlDoc.importNode(r, true)));
            }
        }
        zip.file("word/document.xml", serializer.serializeToString(xmlDoc));
    }

    const finalBlob = zip.generate({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const filename = `Photo direction ${format} ${orientation === 'portrait' ? 'Portrait' : 'Landscape'} Doc.docx`;
    saveAs(finalBlob, filename);
};