
import React from 'react';
import ChatInterface from './components/ChatInterface';

const App: React.FC = () => {
  return (
    <div className="min-h-screen text-slate-100 flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-6xl mx-auto">
        <header className="text-center mb-8">
          <h1 className="text-4xl md:text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-cyan-300 to-purple-400 tracking-tight">
            AI Conversationalist
          </h1>
          <p className="text-slate-400 mt-2 text-lg">
            Engage with AI through <span className="title-highlight">text, voice, and content analysis.</span>
          </p>
        </header>
        <main className="glass-container glow-border rounded-2xl shadow-2xl shadow-black/40">
          <ChatInterface />
        </main>
        <footer className="text-center mt-8 text-slate-500 text-sm">
          <p>Powered by Gemini</p>
        </footer>
      </div>
    </div>
  );
};

export default App;