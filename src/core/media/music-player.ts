import { EventEmitter } from 'events';

export interface MusicTrackInfo {
  videoId: string;
  title: string;
  artist: string;
  duration: string;
  url: string;
  thumbnail: string;
}

export interface MusicPlayerState {
  isPlaying: boolean;
  isPaused: boolean;
  volume: number; // 0 - 100
  currentTrack?: MusicTrackInfo;
}

export interface MusicPlayerActionEvent {
  type: 'music_player_action';
  action: 'play' | 'pause' | 'resume' | 'stop' | 'volume';
  track?: MusicTrackInfo;
  volume?: number;
}

export class MusicPlayerManager extends EventEmitter {
  private state: MusicPlayerState = {
    isPlaying: false,
    isPaused: false,
    volume: 80,
  };

  public getState(): MusicPlayerState {
    return { ...this.state };
  }

  public play(track: MusicTrackInfo): void {
    this.state = {
      isPlaying: true,
      isPaused: false,
      volume: this.state.volume,
      currentTrack: track,
    };
    this.emit('action', {
      type: 'music_player_action',
      action: 'play',
      track,
      volume: this.state.volume,
    } as MusicPlayerActionEvent);
  }

  public pause(): void {
    this.state.isPaused = true;
    this.emit('action', {
      type: 'music_player_action',
      action: 'pause',
      track: this.state.currentTrack,
    } as MusicPlayerActionEvent);
  }

  public resume(): void {
    this.state.isPaused = false;
    this.emit('action', {
      type: 'music_player_action',
      action: 'resume',
      track: this.state.currentTrack,
    } as MusicPlayerActionEvent);
  }

  public stop(): void {
    this.state.isPlaying = false;
    this.state.isPaused = false;
    this.emit('action', {
      type: 'music_player_action',
      action: 'stop',
    } as MusicPlayerActionEvent);
  }

  public setVolume(volume: number): void {
    const vol = Math.max(0, Math.min(100, Math.round(volume)));
    this.state.volume = vol;
    this.emit('action', {
      type: 'music_player_action',
      action: 'volume',
      volume: vol,
    } as MusicPlayerActionEvent);
  }
}

export const musicPlayerManager = new MusicPlayerManager();
