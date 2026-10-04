import { ToolRegistry } from '../core/tools/tool-registry';
import { consultarClimaTool } from './low-risk/consultar-clima';
import { criarLembreteTool } from './low-risk/criar-lembrete';
import { consultarAgendaTool } from './low-risk/consultar-agenda';
import { buscarWebTool } from './low-risk/buscar-web';
import { consultarDataHoraTool } from './low-risk/consultar-data-hora';
import { consultarLogsSistemaTool } from './low-risk/consultar-logs-sistema';
import {
  tocarMusicaTool,
  pausarMusicaTool,
  retomarMusicaTool,
  pararMusicaTool,
  ajustarVolumeMusicaTool,
} from './low-risk/player-musica';
import { destrancarFechaduraTool } from './sensitive/destrancar-fechadura';
import { ligarDispositivoTool, desligarDispositivoTool } from './sensitive/dispositivos';

export const ALL_TOOLS = [
  consultarClimaTool,
  criarLembreteTool,
  consultarAgendaTool,
  buscarWebTool,
  consultarDataHoraTool,
  consultarLogsSistemaTool,
  tocarMusicaTool,
  pausarMusicaTool,
  retomarMusicaTool,
  pararMusicaTool,
  ajustarVolumeMusicaTool,
  destrancarFechaduraTool,
  ligarDispositivoTool,
  desligarDispositivoTool,
];

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_TOOLS);
  return registry;
}

export {
  consultarClimaTool,
  criarLembreteTool,
  consultarAgendaTool,
  buscarWebTool,
  consultarDataHoraTool,
  consultarLogsSistemaTool,
  tocarMusicaTool,
  pausarMusicaTool,
  retomarMusicaTool,
  pararMusicaTool,
  ajustarVolumeMusicaTool,
  destrancarFechaduraTool,
  ligarDispositivoTool,
  desligarDispositivoTool,
};
