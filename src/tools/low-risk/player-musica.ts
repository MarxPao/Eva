import { z } from 'zod';
import yts from 'yt-search';
import { ToolDefinition } from '../../core/tools/types';
import { musicPlayerManager, MusicTrackInfo } from '../../core/media/music-player';

// ============================================================================
// 1. Tocar Música no YouTube
// ============================================================================
export const TocarMusicaSchema = z.object({
  busca: z
    .string()
    .min(1, 'O nome da música ou termo de busca é obrigatório')
    .describe('Nome da música, artista, álbum ou termo de busca no YouTube (ex: "Coldplay Yellow", "lofi relaxante", "Queen Bohemian Rhapsody")'),
});

export type TocarMusicaInput = z.infer<typeof TocarMusicaSchema>;

export interface TocarMusicaResult {
  status: 'reproduzindo';
  titulo: string;
  artista: string;
  duracao: string;
  url: string;
  videoId: string;
  thumbnail: string;
  mensagem: string;
}

export const tocarMusicaTool: ToolDefinition<TocarMusicaInput, TocarMusicaResult> = {
  name: 'tocar_musica',
  description:
    'Busca e reproduz imediatamente uma música, artista, playlist ou vídeo no player do YouTube integrado da EVA.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: TocarMusicaSchema,
  execute: async (params) => {
    const searchResult = await yts(params.busca);
    const video = searchResult.videos && searchResult.videos.length > 0 ? searchResult.videos[0] : null;

    if (!video) {
      throw new Error(`Nenhum vídeo ou música encontrada no YouTube para "${params.busca}".`);
    }

    const track: MusicTrackInfo = {
      videoId: video.videoId,
      title: video.title,
      artist: video.author?.name || 'YouTube',
      duration: video.timestamp || 'Desconhecida',
      url: video.url,
      thumbnail: video.thumbnail || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`,
    };

    musicPlayerManager.play(track);

    return {
      status: 'reproduzindo',
      titulo: track.title,
      artista: track.artist,
      duracao: track.duration,
      url: track.url,
      videoId: track.videoId,
      thumbnail: track.thumbnail,
      mensagem: `Tocando "${track.title}" no YouTube.`,
    };
  },
};

// ============================================================================
// 2. Pausar Música
// ============================================================================
export const PausarMusicaSchema = z.object({});
export type PausarMusicaInput = z.infer<typeof PausarMusicaSchema>;

export interface PausarMusicaResult {
  status: 'pausado';
  mensagem: string;
}

export const pausarMusicaTool: ToolDefinition<PausarMusicaInput, PausarMusicaResult> = {
  name: 'pausar_musica',
  description: 'Pausa a reprodução atual da música no player do YouTube.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: PausarMusicaSchema,
  execute: async () => {
    musicPlayerManager.pause();
    return {
      status: 'pausado',
      mensagem: 'Música pausada.',
    };
  },
};

// ============================================================================
// 3. Retomar Música
// ============================================================================
export const RetomarMusicaSchema = z.object({});
export type RetomarMusicaInput = z.infer<typeof RetomarMusicaSchema>;

export interface RetomarMusicaResult {
  status: 'reproduzindo';
  mensagem: string;
}

export const retomarMusicaTool: ToolDefinition<RetomarMusicaInput, RetomarMusicaResult> = {
  name: 'retomar_musica',
  description: 'Retoma a reprodução da música pausada no player do YouTube.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: RetomarMusicaSchema,
  execute: async () => {
    musicPlayerManager.resume();
    return {
      status: 'reproduzindo',
      mensagem: 'Música retomada.',
    };
  },
};

// ============================================================================
// 4. Parar Música
// ============================================================================
export const PararMusicaSchema = z.object({});
export type PararMusicaInput = z.infer<typeof PararMusicaSchema>;

export interface PararMusicaResult {
  status: 'parado';
  mensagem: string;
}

export const pararMusicaTool: ToolDefinition<PararMusicaInput, PararMusicaResult> = {
  name: 'parar_musica',
  description: 'Para completamente a música e fecha a reprodução atual do player do YouTube.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: PararMusicaSchema,
  execute: async () => {
    musicPlayerManager.stop();
    return {
      status: 'parado',
      mensagem: 'Música parada.',
    };
  },
};

// ============================================================================
// 5. Ajustar Volume da Música
// ============================================================================
export const AjustarVolumeMusicaSchema = z.object({
  volume: z
    .number()
    .int()
    .min(0, 'Volume mínimo é 0')
    .max(100, 'Volume máximo é 100')
    .describe('Nível de volume desejado de 0 a 100%'),
});

export type AjustarVolumeMusicaInput = z.infer<typeof AjustarVolumeMusicaSchema>;

export interface AjustarVolumeMusicaResult {
  status: 'volume_ajustado';
  volume: number;
  mensagem: string;
}

export const ajustarVolumeMusicaTool: ToolDefinition<
  AjustarVolumeMusicaInput,
  AjustarVolumeMusicaResult
> = {
  name: 'ajustar_volume_musica',
  description: 'Ajusta o nível de volume do player de música do YouTube de 0 a 100%.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: AjustarVolumeMusicaSchema,
  execute: async (params) => {
    musicPlayerManager.setVolume(params.volume);
    return {
      status: 'volume_ajustado',
      volume: params.volume,
      mensagem: `Volume do player ajustado para ${params.volume}%.`,
    };
  },
};
