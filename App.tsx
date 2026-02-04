
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameScreen, Player, TargetScore, Question, GameState, GameMessage } from './types';
import { BubbleCard, BubbleButton } from './components/BubbleCard';
import { generateDailyQuestion, checkAnswerSimilarity } from './services/geminiService';
import Peer, { DataConnection } from 'peerjs';

const App: React.FC = () => {
  const [screen, setScreen] = useState<GameScreen>(GameScreen.ENTRY);
  const [isJoining, setIsJoining] = useState(false);
  const [roomId, setRoomId] = useState('');
  const [inputRoomId, setInputRoomId] = useState('');
  const [myPlayerName, setMyPlayerName] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [targetScore, setTargetScore] = useState<TargetScore>(50);
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState(0);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [userInput, setUserInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [connStatus, setConnStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [winner, setWinner] = useState<Player | null>(null);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  
  const broadcastState = useCallback((overrides: Partial<GameState> = {}) => {
    if (!isHost) return;
    const currentState: GameState = {
      players,
      targetScore,
      currentPlayerIdx,
      currentQuestion,
      screen,
      winner,
      ...overrides
    };
    connectionsRef.current.forEach(conn => {
      if (conn.open) {
        conn.send({ type: 'STATE_UPDATE', state: currentState });
      }
    });
  }, [isHost, players, targetScore, currentPlayerIdx, currentQuestion, screen, winner]);

  useEffect(() => {
    if (isHost && screen !== GameScreen.ENTRY) {
      broadcastState();
    }
  }, [players, targetScore, currentPlayerIdx, currentQuestion, screen, winner, isHost, broadcastState]);

  const handleIncomingData = async (data: any) => {
    const msg = data as GameMessage;
    if (msg.type === 'STATE_UPDATE') {
      const s = msg.state;
      setPlayers(s.players);
      setTargetScore(s.targetScore);
      setCurrentPlayerIdx(s.currentPlayerIdx);
      setCurrentQuestion(s.currentQuestion);
      setScreen(s.screen);
      setWinner(s.winner);
      setConnStatus('connected');
    } 
    else if (msg.type === 'JOIN_REQUEST' && isHost) {
      setPlayers(prev => {
        if (prev.length >= 5) return prev;
        if (prev.find(p => p.id === msg.id)) return prev;
        return [...prev, { id: msg.id, name: msg.name, score: 0 }];
      });
    }
    else if (msg.type === 'SUBMIT_ANSWER' && isHost) {
      await processAnswer(msg.answer, msg.playerId);
    }
  };

  const createRoom = () => {
    if (!myPlayerName.trim()) return alert("Masukkan namamu!");
    setIsHost(true);
    setConnStatus('connecting');
    
    // PeerJS secara otomatis menggunakan server awan gratis jika tidak ada opsi yang diberikan
    const peer = new Peer();
    peerRef.current = peer;

    peer.on('open', (id) => {
      setRoomId(id);
      setPlayers([{ id, name: myPlayerName, score: 0, isHost: true }]);
      setScreen(GameScreen.LOBBY);
      setConnStatus('connected');
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        connectionsRef.current.push(conn);
        const currentState: GameState = {
          players, targetScore, currentPlayerIdx, currentQuestion, screen, winner
        };
        conn.send({ type: 'STATE_UPDATE', state: currentState });
      });
      conn.on('data', (data) => handleIncomingData(data));
    });

    peer.on('error', (err) => {
      console.error("Peer Error:", err);
      setConnStatus('error');
      alert("Error koneksi PeerJS. Pastikan internet stabil.");
    });
  };

  const joinRoom = () => {
    if (!inputRoomId.trim() || !myPlayerName.trim()) return alert("Nama dan Kode Room wajib diisi!");
    
    setIsHost(false);
    setConnStatus('connecting');
    
    const peer = new Peer();
    peerRef.current = peer;

    peer.on('open', (myId) => {
      const conn = peer.connect(inputRoomId.trim());
      
      conn.on('open', () => {
        connectionsRef.current = [conn];
        conn.send({ type: 'JOIN_REQUEST', name: myPlayerName, id: myId });
        setRoomId(inputRoomId.trim());
        setScreen(GameScreen.LOBBY);
        setConnStatus('connected');
      });

      conn.on('data', (data) => handleIncomingData(data));
      
      conn.on('error', (err) => {
        setConnStatus('error');
        alert("Gagal menyambung. Kode room mungkin salah atau Host sudah keluar.");
      });
    });

    peer.on('error', (err) => {
      console.error("Peer Error:", err);
      setConnStatus('error');
      alert("Koneksi gagal. Coba lagi.");
    });
  };

  const startGame = async () => {
    if (players.length < 2) return alert("Minimal 2 pemain!");
    setIsLoading(true);
    const question = await generateDailyQuestion();
    setCurrentQuestion(question);
    setScreen(GameScreen.PLAYING);
    setIsLoading(false);
  };

  const processAnswer = async (answer: string, playerId: string) => {
    if (!currentQuestion || isLoading) return;
    
    const pIdx = players.findIndex(p => p.id === playerId);
    if (pIdx !== currentPlayerIdx) return;

    setIsLoading(true);
    setMessage(`Mengecek jawaban ${players[pIdx].name}...`);

    const targetTexts = currentQuestion.answers.map(a => a.text);
    const matchIndex = await checkAnswerSimilarity(answer, targetTexts);

    if (matchIndex !== null && !currentQuestion.answers[matchIndex].revealed) {
      const updatedAnswers = [...currentQuestion.answers];
      updatedAnswers[matchIndex].revealed = true;
      
      const updatedPlayers = [...players];
      updatedPlayers[pIdx].score += 5;
      
      const isWinner = updatedPlayers[pIdx].score >= targetScore;
      const nextQuestionNeeded = updatedAnswers.every(a => a.revealed);
      
      if (isWinner) {
        setWinner(updatedPlayers[pIdx]);
        setScreen(GameScreen.WINNER);
        setPlayers(updatedPlayers);
        setCurrentQuestion({ ...currentQuestion, answers: updatedAnswers });
      } else if (nextQuestionNeeded) {
        setPlayers(updatedPlayers);
        setCurrentQuestion({ ...currentQuestion, answers: updatedAnswers });
        setMessage('🎉 SEMUA TERJAWAB! Ganti pertanyaan...');
        setTimeout(async () => {
          const q = await generateDailyQuestion();
          setCurrentQuestion(q);
          setCurrentPlayerIdx(prev => (prev + 1) % updatedPlayers.length);
          setMessage('');
        }, 2000);
      } else {
        setPlayers(updatedPlayers);
        setCurrentQuestion({ ...currentQuestion, answers: updatedAnswers });
        setMessage('🎉 TEPAT SEKALI! +5 Poin!');
        setTimeout(() => setMessage(''), 2000);
      }
    } else {
      setMessage('❌ Salah! Giliran pemain berikutnya.');
      setTimeout(() => {
        setCurrentPlayerIdx(prev => (prev + 1) % players.length);
        setMessage('');
      }, 2000);
    }
    setIsLoading(false);
  };

  const handleClientSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!userInput.trim()) return;
    
    if (isHost) {
      processAnswer(userInput, roomId);
    } else {
      if (connectionsRef.current[0] && connectionsRef.current[0].open) {
        connectionsRef.current[0].send({ 
          type: 'SUBMIT_ANSWER', 
          answer: userInput, 
          playerId: peerRef.current?.id 
        });
      } else {
        alert("Koneksi terputus dari Host!");
      }
    }
    setUserInput('');
  };

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8 min-h-screen flex flex-col justify-center">
      <header className="text-center mb-8">
        <h1 className="text-5xl md:text-7xl font-fredoka text-white drop-shadow-lg animate-bounce">
          Family 100
        </h1>
        <p className="text-white font-bold tracking-widest mt-2 uppercase opacity-80">Online Multiplayer</p>
      </header>

      {screen === GameScreen.ENTRY && !isJoining && (
        <BubbleCard className="text-center animate-in zoom-in duration-300">
          <h2 className="text-2xl font-bold text-gray-800 mb-6">Siapa namamu?</h2>
          <input
            type="text"
            value={myPlayerName}
            onChange={(e) => setMyPlayerName(e.target.value)}
            placeholder="Ketik namamu..."
            className="w-full bg-gray-50 border-4 border-gray-100 p-5 rounded-[2rem] text-xl font-bold mb-6 text-center focus:border-blue-300 outline-none"
          />
          <div className="flex flex-col gap-4">
            <BubbleButton onClick={createRoom} disabled={connStatus === 'connecting'} className="text-xl py-4">
              {connStatus === 'connecting' && isHost ? 'Membuka Room...' : 'Buat Room Baru'}
            </BubbleButton>
            <BubbleButton onClick={() => setIsJoining(true)} variant="secondary" className="text-xl py-4">
              Gabung Room Teman
            </BubbleButton>
          </div>
        </BubbleCard>
      )}

      {screen === GameScreen.ENTRY && isJoining && (
        <BubbleCard className="text-center animate-in slide-in-from-right duration-300 relative">
          <button onClick={() => setIsJoining(false)} className="absolute left-6 top-6 text-gray-400 font-bold">←</button>
          <h2 className="text-2xl font-bold text-gray-800 mb-2 mt-4">Gabung Room</h2>
          <p className="text-gray-500 mb-6 italic">Masukkan kode dari temanmu</p>
          
          <input
            autoFocus
            type="text"
            value={inputRoomId}
            onChange={(e) => setInputRoomId(e.target.value.toLowerCase())}
            placeholder="Kode Room..."
            className="w-full bg-blue-50 border-4 border-blue-100 p-5 rounded-[2rem] text-2xl font-fredoka mb-6 text-center focus:border-blue-300 outline-none uppercase tracking-widest"
          />
          
          <BubbleButton 
            onClick={joinRoom} 
            disabled={connStatus === 'connecting'} 
            variant="secondary" 
            className="w-full text-xl py-4"
          >
            {connStatus === 'connecting' ? 'Mencari...' : 'Cari Room 🔍'}
          </BubbleButton>
        </BubbleCard>
      )}

      {screen === GameScreen.LOBBY && (
        <BubbleCard className="animate-in fade-in duration-500">
          <div className="text-center mb-8">
            <p className="text-sm font-bold text-gray-400 uppercase tracking-widest">Kode Room:</p>
            <div className="flex items-center justify-center gap-3 mt-2">
              <h2 className="text-4xl md:text-5xl font-fredoka text-blue-500 bg-blue-50 py-4 px-8 rounded-3xl border-4 border-blue-200">
                {roomId || '...'}
              </h2>
            </div>
          </div>

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-bold text-gray-500 mb-2 uppercase text-center">Pemain ({players.length}/5)</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {players.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 bg-gray-50 p-4 rounded-2xl border-2 border-gray-100">
                    <div className="w-10 h-10 bg-yellow-400 rounded-full flex items-center justify-center font-bold text-yellow-900 border-2 border-white">
                      {p.name[0]}
                    </div>
                    <span className="font-bold text-gray-700 truncate">
                      {p.name} {p.id === roomId && '👑'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {isHost ? (
              <div className="space-y-4 pt-4 border-t-2 border-gray-50">
                 <div>
                  <label className="block text-sm font-bold text-gray-500 mb-2 uppercase text-center">Target Menang</label>
                  <div className="flex gap-2">
                    {[30, 50, 100].map(s => (
                      <button 
                        key={s} 
                        onClick={() => setTargetScore(s as TargetScore)}
                        className={`flex-1 p-3 rounded-xl font-bold border-2 transition-all ${targetScore === s ? 'bg-blue-500 text-white border-blue-600' : 'bg-white border-gray-100 text-gray-400'}`}
                      >
                        {s} Pts
                      </button>
                    ))}
                  </div>
                </div>
                <BubbleButton onClick={startGame} className="w-full text-xl py-5" disabled={players.length < 2 || isLoading}>
                  Mulai Game!
                </BubbleButton>
              </div>
            ) : (
              <div className="text-center p-8 bg-yellow-50 rounded-[2.5rem] animate-pulse-soft border-4 border-yellow-100">
                <p className="font-bold text-yellow-700">Menunggu Host...</p>
              </div>
            )}
          </div>
        </BubbleCard>
      )}

      {screen === GameScreen.PLAYING && currentQuestion && (
        <div className="space-y-6 animate-in slide-in-from-bottom duration-500">
          <div className="flex flex-wrap gap-2 justify-center">
            {players.map((p, i) => (
              <div 
                key={p.id} 
                className={`
                  p-3 rounded-[1.5rem] border-4 transition-all flex flex-col items-center min-w-[100px]
                  ${currentPlayerIdx === i 
                    ? 'bg-yellow-100 border-yellow-400 scale-105 shadow-md' 
                    : 'bg-white opacity-60 border-white'}
                `}
              >
                <span className="font-fredoka text-base truncate w-full text-center">{p.name}</span>
                <span className="bg-white px-3 py-1 rounded-full text-xs font-bold mt-1 text-blue-600">
                  {p.score} pts
                </span>
              </div>
            ))}
          </div>

          <BubbleCard>
            <div className="text-center mb-6">
              <p className="text-gray-800 text-xl md:text-2xl font-bold leading-tight">
                "{currentQuestion.prompt}"
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">
              {currentQuestion.answers.map((ans, idx) => (
                <div 
                  key={idx}
                  className={`
                    relative h-12 rounded-xl flex items-center justify-between px-6 font-bold overflow-hidden
                    ${ans.revealed ? 'bg-blue-500 text-white border-blue-600' : 'bg-gray-100 text-gray-300 border-gray-200'}
                    border-2 transition-all duration-500
                  `}
                >
                  <span className="bg-white bg-opacity-20 w-6 h-6 rounded-full flex items-center justify-center mr-3 text-[10px]">
                    {idx + 1}
                  </span>
                  <span className="flex-1 truncate uppercase text-sm">
                    {ans.revealed ? ans.text : '••••••••••••'}
                  </span>
                </div>
              ))}
            </div>

            {(players[currentPlayerIdx].id === peerRef.current?.id || (isHost && currentPlayerIdx === 0)) ? (
              <form onSubmit={handleClientSubmit} className="relative">
                <input
                  autoFocus
                  disabled={isLoading}
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder="Ketik jawabanmu..."
                  className="w-full bg-yellow-50 border-4 border-yellow-200 p-4 rounded-[1.5rem] text-lg font-bold text-gray-700 outline-none focus:border-yellow-400"
                />
                <div className="absolute right-2 top-2 bottom-2">
                  <BubbleButton disabled={isLoading} className="h-full px-6 py-0">KIRIM</BubbleButton>
                </div>
              </form>
            ) : (
              <div className="text-center p-4 bg-gray-50 rounded-[1.5rem] border-2 border-dashed border-gray-200">
                <p className="text-gray-400 font-bold italic">
                  Giliran {players[currentPlayerIdx].name}...
                </p>
              </div>
            )}

            {message && (
              <div className="mt-4 text-center font-bold text-blue-600 animate-bounce">
                {message}
              </div>
            )}
          </BubbleCard>
        </div>
      )}

      {screen === GameScreen.WINNER && winner && (
        <BubbleCard className="text-center animate-in zoom-in">
          <div className="text-6xl mb-4">🏆</div>
          <h2 className="text-2xl font-fredoka text-gray-800 mb-6">Pemenang: {winner.name}!</h2>
          <BubbleButton onClick={() => window.location.reload()} className="w-full">Tutup Room</BubbleButton>
        </BubbleCard>
      )}

      <footer className="mt-12 text-center text-white opacity-40 text-[10px] font-bold">
        Status: {connStatus === 'connected' ? 'ONLINE' : 'OFFLINE'} | Room: {roomId || '-'}
      </footer>
    </div>
  );
};

export default App;
