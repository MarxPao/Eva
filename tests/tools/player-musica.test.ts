import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tocarMusicaTool,
  pausarMusicaTool,
  retomarMusicaTool,
  pararMusicaTool,
  ajustarVolumeMusicaTool,
} from '../../src/tools/low-risk/player-musica';
import { musicPlayerManager } from '../../src/core/media/music-player';
import { ToolExecutionContext } from '../../src/core/tools/types';

vi.mock('yt-search', () => {
  return {
    default: vi.fn(async (query: string) => {
      if (query === 'musica_inexistente_xyz_error') {
        return { videos: [] };
      }
      return {
        videos: [
          {
            videoId: 'mockVideo123',
            title: 'Coldplay - Yellow (Official Video)',
            author: { name: 'Coldplay' },
            timestamp: '4:29',
            url: 'https://youtube.com/watch?v=mockVideo123',
            thumbnail: 'https://img.youtube.com/vi/mockVideo123/hqdefault.jpg',
          },
        ],
      };
    }),
  };
});

describe('Player de Música do YouTube (Ferramentas da EVA)', () => {
  const context: ToolExecutionContext = {
    interactionId: 'test-music-1',
    timestamp: new Date(),
  };

  beforeEach(() => {
    musicPlayerManager.stop();
    musicPlayerManager.setVolume(80);
  });

  it('deve buscar no YouTube e iniciar reprodução de música', async () => {
    const actionSpy = vi.fn();
    musicPlayerManager.on('action', actionSpy);

    const result = await tocarMusicaTool.execute({ busca: 'Coldplay Yellow' }, context);

    expect(result.status).toBe('reproduzindo');
    expect(result.videoId).toBe('mockVideo123');
    expect(result.titulo).toBe('Coldplay - Yellow (Official Video)');
    expect(result.artista).toBe('Coldplay');
    expect(result.duracao).toBe('4:29');
    expect(result.mensagem).toContain('Yellow');

    const state = musicPlayerManager.getState();
    expect(state.isPlaying).toBe(true);
    expect(state.isPaused).toBe(false);
    expect(state.currentTrack?.videoId).toBe('mockVideo123');

    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'music_player_action',
        action: 'play',
        track: expect.objectContaining({ videoId: 'mockVideo123' }),
      })
    );

    musicPlayerManager.off('action', actionSpy);
  });

  it('deve lançar erro se a busca no YouTube não retornar resultados', async () => {
    await expect(
      tocarMusicaTool.execute({ busca: 'musica_inexistente_xyz_error' }, context)
    ).rejects.toThrow('Nenhum vídeo ou música encontrada no YouTube');
  });

  it('deve pausar a reprodução da música', async () => {
    await tocarMusicaTool.execute({ busca: 'Coldplay Yellow' }, context);

    const actionSpy = vi.fn();
    musicPlayerManager.on('action', actionSpy);

    const res = await pausarMusicaTool.execute({}, context);
    expect(res.status).toBe('pausado');

    const state = musicPlayerManager.getState();
    expect(state.isPaused).toBe(true);
    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'music_player_action',
        action: 'pause',
      })
    );

    musicPlayerManager.off('action', actionSpy);
  });

  it('deve retomar a música pausada', async () => {
    await tocarMusicaTool.execute({ busca: 'Coldplay Yellow' }, context);
    await pausarMusicaTool.execute({}, context);

    const actionSpy = vi.fn();
    musicPlayerManager.on('action', actionSpy);

    const res = await retomarMusicaTool.execute({}, context);
    expect(res.status).toBe('reproduzindo');

    const state = musicPlayerManager.getState();
    expect(state.isPaused).toBe(false);
    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'music_player_action',
        action: 'resume',
      })
    );

    musicPlayerManager.off('action', actionSpy);
  });

  it('deve parar a reprodução da música', async () => {
    await tocarMusicaTool.execute({ busca: 'Coldplay Yellow' }, context);

    const actionSpy = vi.fn();
    musicPlayerManager.on('action', actionSpy);

    const res = await pararMusicaTool.execute({}, context);
    expect(res.status).toBe('parado');

    const state = musicPlayerManager.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.isPaused).toBe(false);
    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'music_player_action',
        action: 'stop',
      })
    );

    musicPlayerManager.off('action', actionSpy);
  });

  it('deve ajustar o volume da música e limitar entre 0 e 100', async () => {
    const actionSpy = vi.fn();
    musicPlayerManager.on('action', actionSpy);

    const res = await ajustarVolumeMusicaTool.execute({ volume: 50 }, context);
    expect(res.status).toBe('volume_ajustado');
    expect(res.volume).toBe(50);
    expect(musicPlayerManager.getState().volume).toBe(50);

    expect(actionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'music_player_action',
        action: 'volume',
        volume: 50,
      })
    );

    // Ajusta volume no manager
    musicPlayerManager.setVolume(120);
    expect(musicPlayerManager.getState().volume).toBe(100);

    musicPlayerManager.setVolume(-10);
    expect(musicPlayerManager.getState().volume).toBe(0);

    musicPlayerManager.off('action', actionSpy);
  });
});
