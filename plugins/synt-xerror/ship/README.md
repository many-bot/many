# Ship

Gera uma porcentagem de "combinação" entre dois membros marcados, com imagem
personalizada (fotos de perfil, nomes, corações de fundo e cor variando pela
porcentagem) e legenda engraçada marcando os dois.

## Uso

    !ship @membro1 @membro2

- Só funciona dentro de grupos.
- As duas menções precisam ser reais (não apenas texto digitado).

## Persistência (ctx.settings.global)

- Cada par de pessoas (independente da ordem da menção) tem um score fixo
  guardado por 7 dias — rodar `!ship` de novo dentro desse prazo repete o
  mesmo resultado. Depois de 7 dias, recalcula.
- Se A ou B já tiver um "ship" registrado com qualquer outra pessoa, o
  próximo par **novo** entre eles nasce de propósito com score baixo
  (0–29), simulando ciúme/traição. Isso só afeta a primeira vez que esse
  par específico se forma — pares já existentes mantêm seu score normal.

## Regras do score

- Base: número aleatório inteiro de 0 a 100.
- Multiplicador: se os nomes tiverem 5+ caracteres em comum (conjunto de
  caracteres únicos, sem espaço, case-insensitive), o multiplicador é
  `comuns / 2`; caso contrário, o padrão é `1`.
- **Intencional:** esse multiplicador pode passar de 1 e distorcer a curva
  antes do clamp final — não é bug.
- Resultado final sempre limitado a 0–100.
- Entre 90 e 100: 50% de chance de reduzir 10 pontos.
- 100%: texto rosa-choque (`#ff1493`) com contorno preto.

## Shippar com o bot

Se uma das duas menções for o próprio bot (`ctx.msg.hasBotMention`), o score
é sempre `0%` — não entra na persistência nem no histórico (nunca é
calculado nem guardado). Legenda própria em `caption.bot`, separada das
faixas normais.

## Legenda

Marca (`@`) os dois membros via `mentions` e escolhe uma frase aleatória
(entre 2 variantes) de uma de 7 faixas de score, localizada em
`locale/pt.json` / `locale/en.json` sob `caption.tier0`..`caption.tier6`.

## Visual

- Fundo: gradiente que vai de azul frio (scores baixos) a rosa/vermelho
  quente (scores altos), com corações desenhados por cima em tom
  contrastante com o fundo (preto translúcido em fundo claro, branco
  translúcido em fundo escuro).
- Barra de progresso proporcional ao score, abaixo da porcentagem.
- Nomes muito longos são truncados com `...` para caber sob a foto.
- Fontes: mesma cascata do plugin `welcome`, namespaced `Ship*` (não colide
  com `Welcome*`). Coloque em `plugins/ship/fonts/`:
  `DejaVuSans.ttf`, `DejaVuSans-Bold.ttf`, `LiberationSerif-Regular.ttf`,
  `LiberationSerif-Bold.ttf`, `DejaVuSansMono.ttf`, `DejaVuSansMono-Bold.ttf`,
  `NotoColorEmoji.ttf`, `NotoSansBamum-Regular.ttf`,
  `NotoSerifKhitanSmallScript-Regular.ttf`, `STIXTwoMath-Regular.ttf`.
  Sem os arquivos, cai no `sans-serif` do sistema (sem emoji/CJK/scripts
  raros no pushname desenhado no canvas).

## Falhas tratadas

- Foto de perfil indisponível → avatar padrão desenhado localmente.
- Menção inválida ou não exatamente duas menções → mensagem de erro, sem
  tentar gerar imagem.
- Fora de grupo → mensagem de erro, sem tentar gerar imagem.
- Falha na renderização → mensagem de erro, sem derrubar o bot.

## Dependências

- `@napi-rs/canvas` (binários pré-compilados via napi-rs, sem compilação
  nativa local).

