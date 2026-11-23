# FNF Chromatic Scale Generator

Site que gera uma **Chromatic Scale completa e afinada** para usar em músicas de FNF, a partir da sua própria voz.
Roda 100% no navegador (celular ou PC): nenhum áudio sai do seu aparelho.

## Como funciona

1. **Fonte de áudio**
   - **Áudio único**: envie sua voz falando qualquer coisa *ou* uma chromatic scale já gravada. O **Auto-Corte** rastreia o tom (algoritmo YIN), acha trechos vozeados e estáveis, corta em cruzamento por zero e mede o tom de cada um com precisão de fração de cent.
   - **Partes separadas**: envie vários arquivos (um por nota/sílaba). O tom é medido automaticamente e pode ser corrigido na mão.
2. **Teclado**: escolha a faixa (padrão: teclado completo, C0–B9 na convenção do FL Studio, MIDI 0–119) e a convenção de oitava (FL Studio ou MIDI padrão).
3. **Saída**: cada tecla é reamostrada (sinc janelado) até o tom exato e estendida com *loop* de fase casada, sem cliques, para a duração escolhida. Os volumes são igualados.

## Exportação

- **WAV único** com todas as notas em sequência e marcadores (`cue`) com o nome de cada nota — para fatiar no sampler do FL Studio Mobile.
- **ZIP** com um WAV por tecla (`NNN_Nota.wav`, nota-raiz gravada no `smpl`) + `chromatic.sfz` com cada tecla já mapeada. O DirectWave (FL Studio PC) abre `.sfz` e pode salvar como `.dwp`.

> O formato `.dwp` é proprietário e fechado, então o site não o grava diretamente; o `.sfz` é o caminho aberto equivalente.

## Rodar localmente

```bash
python3 -m http.server 8000   # e abra http://localhost:8000
node tests/dsp.test.js        # testes de precisão do núcleo de áudio
```

Sem dependências nem build: HTML + CSS + JS puro (`js/dsp.js` é o núcleo, `js/app.js` a interface).

## Dicas para um resultado melhor

- Grave vogais **sustentadas e sem vibrato** ("aaaa", "oooo") em tons diferentes, com pouco ruído de fundo.
- Quanto mais fontes em alturas variadas, menos as notas extremas soam "estiradas".
- Se o Auto-Corte não achar nada, use a sensibilidade **Permissiva** ou reduza a duração mínima.
