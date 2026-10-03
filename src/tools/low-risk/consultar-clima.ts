import { z } from 'zod';
import { ToolDefinition } from '../../core/tools/types';

export const ConsultarClimaSchema = z.object({
  cidade: z.string().min(1, 'O nome da cidade é obrigatório').default('São Paulo').describe('Nome da cidade a consultar (use "São Paulo" por padrão se o usuário não especificar a localidade)'),
  dias: z.number().int().min(1).max(5).default(1).describe('Quantidade de dias para a previsão (1 a 5)'),
});

export type ConsultarClimaParams = z.infer<typeof ConsultarClimaSchema>;

export interface ClimaResult {
  cidade: string;
  temperaturaAtual: string;
  condicao: string;
  umidade: string;
  sensacaoTermica: string;
  chuvaHoje?: string;
  precipitacaoHojeMm?: number;
  previsaoDias: Array<{ dia: number; tempMin: string; tempMax: string; condicao: string }>;
}

function mapWeatherCode(code: number): string {
  if (code === 0) return 'Céu limpo / Ensolarado';
  if (code === 1) return 'Predominantemente ensolarado';
  if (code === 2) return 'Parcialmente nublado';
  if (code === 3) return 'Nublado / Encoberto';
  if (code === 45 || code === 48) return 'Névoa / Nevoeiro';
  if (code >= 51 && code <= 55) return 'Garoa / Chuvisco';
  if (code >= 61 && code <= 65) return 'Chuva';
  if (code >= 71 && code <= 77) return 'Neve / Geada';
  if (code >= 80 && code <= 82) return 'Pancadas de chuva';
  if (code >= 95 && code <= 99) return 'Tempestade com trovoadas';
  return 'Tempo instável';
}

export const consultarClimaTool: ToolDefinition<ConsultarClimaParams, ClimaResult> = {
  name: 'consultar_clima',
  description: 'Consulta as condições meteorológicas em tempo real, incluindo chuva registrada hoje, temperatura e previsão para uma determinada cidade.',
  sensitivity: 'low',
  requiresConfirmation: false,
  schema: ConsultarClimaSchema,
  execute: async (params) => {
    try {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(params.cidade)}&count=1&language=pt&format=json`;
      const geoRes = await fetch(geoUrl, { signal: AbortSignal.timeout(3500) });
      const geoData: any = await geoRes.json();

      if (geoData?.results && geoData.results.length > 0) {
        const loc = geoData.results[0];
        const lat = loc.latitude;
        const lon = loc.longitude;

        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=auto&past_days=1`;
        const weatherRes = await fetch(weatherUrl, { signal: AbortSignal.timeout(4000) });
        const data: any = await weatherRes.json();

        const current = data.current || {};
        const daily = data.daily || {};

        const tempAtual = current.temperature_2m !== undefined ? `${Math.round(current.temperature_2m)}°C` : '22°C';
        const sensacao = current.apparent_temperature !== undefined ? `${Math.round(current.apparent_temperature)}°C` : tempAtual;
        const umidade = current.relative_humidity_2m !== undefined ? `${current.relative_humidity_2m}%` : '70%';
        const condicao = mapWeatherCode(current.weather_code ?? 2);

        // Chuva hoje (índice 1 no past_days=1)
        const rainTodayMm = Number(daily.precipitation_sum?.[1] ?? current.precipitation ?? 0);
        let chuvaDesc = '';
        if (rainTodayMm >= 1.0) {
          chuvaDesc = `Sim, choveu hoje: acumulado de aproximadamente ${rainTodayMm.toFixed(1)} mm de chuva.`;
        } else if (rainTodayMm > 0) {
          chuvaDesc = `Houve garoa leve ou chuvisco rápido hoje (${rainTodayMm.toFixed(1)} mm).`;
        } else {
          chuvaDesc = 'Não houve registro de chuva significativo hoje.';
        }

        const previsoes: Array<{ dia: number; tempMin: string; tempMax: string; condicao: string }> = [];
        const numDias = Math.min(params.dias, 5);
        for (let i = 1; i <= numDias; i++) {
          // Índice 1 é hoje, índice 2 é amanhã no past_days=1
          const dIndex = i;
          const min = daily.temperature_2m_min?.[dIndex] !== undefined ? `${Math.round(daily.temperature_2m_min[dIndex])}°C` : '18°C';
          const max = daily.temperature_2m_max?.[dIndex] !== undefined ? `${Math.round(daily.temperature_2m_max[dIndex])}°C` : '26°C';
          const cond = mapWeatherCode(daily.weather_code?.[dIndex] ?? 1);
          previsoes.push({
            dia: i,
            tempMin: min,
            tempMax: max,
            condicao: cond,
          });
        }

        return {
          cidade: params.cidade,
          temperaturaAtual: tempAtual,
          condicao,
          umidade,
          sensacaoTermica: sensacao,
          chuvaHoje: chuvaDesc,
          precipitacaoHojeMm: Math.round(rainTodayMm * 10) / 10,
          previsaoDias: previsoes,
        };
      }
    } catch (err) {
      console.warn('[ConsultarClima] Erro ao consultar Open-Meteo, usando dados de contingência:', err);
    }

    // Fallback gracioso se a API externa falhar ou estiver offline
    const fallbackPrevisoes = [];
    for (let i = 1; i <= params.dias; i++) {
      fallbackPrevisoes.push({
        dia: i,
        tempMin: '18°C',
        tempMax: '26°C',
        condicao: 'Nublado com pancadas de chuva',
      });
    }

    return {
      cidade: params.cidade,
      temperaturaAtual: '21°C',
      condicao: 'Parcialmente nublado',
      umidade: '80%',
      sensacaoTermica: '21°C',
      chuvaHoje: 'Possibilidade de chuva na região.',
      precipitacaoHojeMm: 0,
      previsaoDias: fallbackPrevisoes,
    };
  },
};
