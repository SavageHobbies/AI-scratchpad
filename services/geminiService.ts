
import { GoogleGenAI, GenerateContentResponse, Chat, Modality } from "@google/genai";
import { ChatMessage, Transcript } from '../types';

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  throw new Error("API_KEY environment variable not set");
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

let chatInstance: Chat | null = null;

const getChatInstance = (context: string): Chat => {
  if (!chatInstance) {
    chatInstance = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: `You are a helpful assistant. The user has provided the following text to discuss. Base all your answers on this text. Do not use outside knowledge unless explicitly asked. The text is: \n\n---START OF TEXT---\n${context}\n---END OF TEXT---`,
      },
    });
  }
  return chatInstance;
};

export const resetChat = () => {
  chatInstance = null;
};

export const getChatResponse = async (
  context: string,
  message: string
): Promise<GenerateContentResponse> => {
  const chat = getChatInstance(context);
  const response = await chat.sendMessage({ message });
  return response;
};

export const getTextToSpeech = async (text: string): Promise<string | null> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });
    
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio || null;
  } catch (error) {
    console.error("Error generating speech:", error);
    return null;
  }
};

export const organizeNotes = async (notes: string): Promise<string> => {
    if (!notes.trim()) {
        return '';
    }
    try {
        const prompt = `Please organize and reformat the following notes clearly and concisely. 
- If there are mathematical calculations, show the steps or a clear breakdown.
- If there are lists of items or ideas, format them using bullet points or numbered lists.
- Correct any minor typos or grammatical errors.
- Structure the information logically.

The notes are:
---START OF NOTES---
${notes}
---END OF NOTES---`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        return response.text.trim();
    } catch (error) {
        console.error("Error organizing notes:", error);
        return "Sorry, I couldn't organize the notes at this time.";
    }
};

export const summarizeConversation = async (history: (ChatMessage | Transcript)[]): Promise<string> => {
    if (history.length === 0) {
        return "There was no conversation to summarize.";
    }

    const formattedHistory = history.map(item => {
        if ('role' in item) { // ChatMessage
            return `${item.role === 'user' ? 'User' : 'AI'}: ${item.text}`;
        } else { // Transcript
             const speaker = item.source.startsWith('user') ? 'User' : 'AI';
             return `${speaker}: ${item.text}`;
        }
    }).join('\n');

    try {
        const prompt = `Please provide a concise summary of the following conversation. Identify the key topics, decisions, and action items.

The conversation is:
---START OF CONVERSATION---
${formattedHistory}
---END OF CONVERSATION---`;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
        });
        return response.text.trim();
    } catch (error) {
        console.error("Error summarizing conversation:", error);
        return "Sorry, I couldn't summarize the conversation at this time.";
    }
};