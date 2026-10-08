# release-notifier

Plugin do ManyBot que avisa num chat do WhatsApp sempre que sai uma release
nova — checando periodicamente o endpoint `:3006/release` do
[`release-hooks-server`](../release-hooks-server), o setup de post-receive +
staged publishing feito junto com esse plugin.

## Instalação

Copia a pasta `plugins/release-notifier/` pra dentro da pasta `plugins/` do
seu ManyBot. Se você usa `manyplug`, dá pra colocar na pasta gerenciada por
ele normalmente.

## Configuração

Nenhuma é obrigatória — o plugin funciona com os padrões abaixo, só
sobrescreva no `manybot.toml` se precisar:

```toml
RELEASE_ENDPOINT = "http://localhost:3006/release"  # onde fica o release-server
RELEASE_POLL_CRON = "*/2 * * * *"                    # frequência do polling (cron)
RELEASE_CHAT_ID = "5511999999999@c.us"               # chat padrão (opcional)
```

Se o `release-server` roda numa máquina diferente do bot, ajuste
`RELEASE_ENDPOINT` pro IP/host certo (e garanta que a porta 3006 esteja
acessível dali).

## Definindo o chat pelo WhatsApp

Não precisa mexer em config nenhuma pra escolher o chat — manda isso no chat
que você quer que receba os avisos:

```
!release aqui
```

Isso fica salvo em `ctx.settings.global` (sobrescreve o `RELEASE_CHAT_ID` do
`manybot.toml`, se houver um).

## Comandos

| Comando | O que faz |
|---|---|
| `!release` | Mostra o chat configurado atualmente e o menu de comandos. |
| `!release aqui` | Define o chat atual como destino dos avisos. |
| `!release check` | Força uma checagem imediata no endpoint (não espera o próximo tick do cron). |

## Como evita avisar a mesma release duas vezes

Guarda a última tag avisada em `ctx.storage` (`last-tag.json`, sobrevive a
reinícios do bot). Só manda mensagem quando a `tag` do `/release` mudar em
relação à última salva.

## Mensagem enviada

```
🚀 *Nova release: [RC] v5.6.0-rc.2*
Tag: `v5.6.0-rc.2`
Status: 🧪 release candidate (não publicada)
Commit: `71af04c`

- 5.6.0-rc.2 (61a5011)
- fix: remove allowScripts from package.json (5b87d39)
```

O texto de "Status" muda de acordo com o `status` que o `release-server`
reporta: `rc-built`, `staged` (esperando `npm stage approve`), `published` ou
`built`.
