import { GoogleGenAI } from "@google/genai";
import { PhotoData } from "../types";

const GEMINI_API_KEY = process.env.API_KEY || '';
// Initialize once if key is present, otherwise handle in call
let ai: GoogleGenAI | null = null;

if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
}

export const analyzeLocationWithGemini = async (photo: PhotoData): Promise<string> => {
  if (!ai) {
    throw new Error("API Key is missing. Please configure the environment.");
  }
  
  if (!photo.coordinates) {
    return "No GPS coordinates found for this image, so I cannot provide location-specific context.";
  }

  try {
    // Convert file to base64
    const base64Data = await fileToGenerativePart(photo.file);
    
    const prompt = `
      I have taken this photo at coordinates: 
      Latitude: ${photo.coordinates.latitude}
      Longitude: ${photo.coordinates.longitude}
      
      Please act as a professional travel guide and historian.
      1. Identify the likely location (city, landmark, or region).
      2. Provide 2-3 interesting facts about this specific place.
      3. Comment briefly on the visual content of the image itself in relation to the location.
      
      Keep the tone engaging and concise (under 200 words).
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          { inlineData: { mimeType: photo.file.type, data: base64Data } },
          { text: prompt }
        ]
      }
    });

    return response.text || "Could not generate analysis.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "Failed to analyze the location using Gemini. Please try again.";
  }
};

async function fileToGenerativePart(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
