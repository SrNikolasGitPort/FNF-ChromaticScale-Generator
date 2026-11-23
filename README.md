# FNF Chromatic Scale Generator

Envie sua voz e receba uma **chromatic completa (C0 a B9)**, afinada e pronta para o FL Studio Mobile ou PC.
Roda 100% no navegador: nenhum áudio sai do seu aparelho.

## Como usar

- **1 áudio** (você falando qualquer coisa): o site recorta as melhores partes (trechos com tom estável) e monta a chromatic com elas.
- **Vários áudios**: cada áudio vira uma nota, **em ordem do mais grave ao mais agudo**. Todos os áudios com tom são usados; se dois caírem na mesma nota, o seguinte vai para a próxima tecla livre. Áudios sem tom (ruído) são ignorados, com aviso.

Depois é só baixar:

| Arquivo | Para quê |
|---|---|
| **DWP** | Instrumento do DirectWave (FL Studio Mobile e PC), uma tecla por nota |
| **WAV** | Todas as notas em sequência, com marcadores de corte por nota |
| **ZIP** | Um WAV por tecla + `chromatic.sfz` mapeado |

## Como a voz é estendida

Cada tecla é gerada por **PSOLA**, que muda o tom sem deformar o timbre da voz (os formantes ficam onde estão, sem efeito "esquilo"). A nota é prolongada reaproveitando os ciclos da própria voz, sem emendas nem cliques. Para tons muito distantes da voz original (mais de 1 oitava), o restante é feito por reamostragem. As notas ficam afinadas ao cent: nos testes, erro < 1 cent nas 120 teclas.

## Testes

```bash
node tests/dsp.test.js     # detecção de tom, Auto-Corte, WAV/ZIP
node tests/psola.test.js   # afinação das 120 teclas, formantes, ordem das partes
node tests/dwp.test.js     # estrutura do DWP + FLAC embutido (precisa do ffmpeg)
```

Sem dependências nem build: HTML + CSS + JS puro.

## Observação sobre o DWP

O formato `.dwp` é fechado; este site o escreve seguindo a engenharia reversa do projeto
[ConvertWithMoss](https://github.com/git-moss/ConvertWithMoss) (Jürgen Moßgraber). `js/dwp.js` é um port desse código
e, por isso, é distribuído sob a **LGPL v3**. O arquivo é validado estruturalmente e o áudio embutido é decodificado
bit a bit nos testes, mas a abertura no FL Studio em si deve ser conferida no seu aparelho.

## Dicas

- Grave vogais **sustentadas e limpas** ("aaaa", "oooo"), com pouco ruído de fundo.
- Quanto mais partes em alturas diferentes, mais natural fica nas notas extremas.
