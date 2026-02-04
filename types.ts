
export interface Player {
  id: string;
  name: string;
  score: number;
  isHost?: boolean;
}

export interface SurveyAnswer {
  text: string;
  revealed: boolean;
}

export interface Question {
  prompt: string;
  answers: SurveyAnswer[];
}

export enum GameScreen {
  ENTRY = 'ENTRY',
  LOBBY = 'LOBBY',
  SETUP = 'SETUP',
  PLAYING = 'PLAYING',
  WINNER = 'WINNER'
}

export type TargetScore = 30 | 50 | 100;

export interface GameState {
  players: Player[];
  targetScore: TargetScore;
  currentPlayerIdx: number;
  currentQuestion: Question | null;
  screen: GameScreen;
  winner: Player | null;
}

export type GameMessage = 
  | { type: 'STATE_UPDATE', state: GameState }
  | { type: 'JOIN_REQUEST', name: string, id: string }
  | { type: 'SUBMIT_ANSWER', answer: string, playerId: string };
