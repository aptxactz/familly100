
import { GoogleGenAI, Type } from "@google/genai";
import { Question } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

export const generateDailyQuestion = async (): Promise<Question> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: "Buat satu pertanyaan kuis ala Family 100 tentang kehidupan sehari-hari di Indonesia. Berikan 5 jawaban paling populer. Gunakan format JSON.",
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            prompt: { type: Type.STRING, description: "Pertanyaan survei" },
            answers: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  text: { type: Type.STRING, description: "Jawaban survei" }
                },
                required: ["text"]
              }
            }
          },
          required: ["prompt", "answers"]
        }
      }
    });

    const data = JSON.parse(response.text);
    return {
      prompt: data.prompt,
      answers: data.answers.map((a: any) => ({ text: a.text, revealed: false }))
    };
  } catch (error) {
    console.error("Error generating question:", error);
    // Fallback question
    return {
      prompt: "Apa yang biasa dibawa orang saat pergi ke kantor?",
      answers: [
        { text: "Tas", revealed: false },
        { text: "Laptop", revealed: false },
        { text: "Bekal", revealed: false },
        { text: "Dompet", revealed: false },
        { text: "Handphone", revealed: false }
      ]
    };
  }
};

export const checkAnswerSimilarity = async (userInput: string, targetAnswers: string[]): Promise<number | null> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Apakah jawaban "${userInput}" memiliki arti yang sama atau sangat mirip dengan salah satu dari jawaban berikut: [${targetAnswers.join(", ")}]? Jika ya, sebutkan index jawabannya (mulai dari 0). Jika tidak ada yang cocok, kembalikan null. Gunakan format JSON.`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            index: { type: Type.NUMBER, nullable: true }
          }
        }
      }
    });

    const data = JSON.parse(response.text);
    return typeof data.index === 'number' ? data.index : null;
  } catch (error) {
    console.error("Error checking answer:", error);
    return null;
  }
};
