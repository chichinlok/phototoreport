import { jsPDF } from "jspdf";
import { PhotoData } from "../types";

// Helper: Compress Image to target specific size
// We estimate target file size based on photo count to stay under 10MB total
const compressImageForPdf = async (file: File, quality: number = 0.6, maxWidth: number = 1600): Promise<string> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        
        img.onload = () => {
            URL.revokeObjectURL(url);
            
            let width = img.width;
            let height = img.height;
            
            // Resize logic
            if (width > maxWidth || height > maxWidth) {
                const aspect = width / height;
                if (width > height) {
                    width = maxWidth;
                    height = width / aspect;
                } else {
                    height = maxWidth;
                    width = height * aspect;
                }
            }
            
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error("Canvas context failed"));
                return;
            }
            
            ctx.drawImage(img, 0, 0, width, height);
            
            // Return base64 for jsPDF
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            resolve(dataUrl);
        };
        
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Image load failed"));
        };
        
        img.src = url;
    });
};

export const generateCompressedPdf = async (photos: PhotoData[]) => {
    try {
        const activePhotos = photos.filter(p => !p.isDeleted).sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
        
        if (activePhotos.length === 0) return;

        // Calculate Budget
        // Target ~9.5MB to be safe. 
        // 9.5MB = 9,961,472 bytes.
        // PDF overhead is small per page, mostly images.
        const TARGET_BYTES = 9.5 * 1024 * 1024;
        const budgetPerPhoto = TARGET_BYTES / activePhotos.length;
        
        // Determine quality settings based on budget
        let quality = 0.6;
        let maxWidth = 1200;

        if (budgetPerPhoto < 100 * 1024) { // < 100KB
            quality = 0.4;
            maxWidth = 800;
        } else if (budgetPerPhoto > 500 * 1024) { // > 500KB
            quality = 0.75;
            maxWidth = 1600;
        }

        const doc = new jsPDF({
            orientation: 'portrait',
            unit: 'mm',
            format: 'a4'
        });

        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const margin = 20;
        const contentWidth = pageWidth - (margin * 2);
        
        // Layout: 2 photos per page
        // Photo Box Height approx 110mm
        const photoHeightBox = 110;
        
        let yCursor = margin;

        for (let i = 0; i < activePhotos.length; i++) {
            const photo = activePhotos[i];
            
            // New Page check
            if (i > 0 && i % 2 === 0) {
                doc.addPage();
                yCursor = margin;
            }

            // Compress Image
            const imgData = await compressImageForPdf(photo.file, quality, maxWidth);
            
            // Get Image Aspect Ratio to center it
            const imgProps = doc.getImageProperties(imgData);
            const imgRatio = imgProps.width / imgProps.height;
            
            // Calculate display dims
            let displayW = contentWidth;
            let displayH = displayW / imgRatio;
            
            // Max height for the image area (leaving space for text)
            const maxImgH = photoHeightBox - 15; // 15mm for text
            
            if (displayH > maxImgH) {
                displayH = maxImgH;
                displayW = displayH * imgRatio;
            }
            
            // Center horizontally
            const xPos = margin + (contentWidth - displayW) / 2;
            
            doc.addImage(imgData, 'JPEG', xPos, yCursor, displayW, displayH);
            
            // Add Text
            const textY = yCursor + displayH + 7;
            doc.setFontSize(12);
            doc.setFont("helvetica", "bold");
            
            // Center text
            const text = photo.name;
            const textWidth = doc.getStringUnitWidth(text) * 12 / 2.83465; // Font size scale factor
            const textX = margin + (contentWidth - textWidth) / 2;
            
            doc.text(text, pageWidth / 2, textY, { align: 'center' });

            // Move cursor
            yCursor += photoHeightBox + 10; // Spacing
        }

        doc.save("Photo_Journal_Compressed.pdf");

    } catch (error) {
        console.error("PDF Generation failed:", error);
        throw error;
    }
};