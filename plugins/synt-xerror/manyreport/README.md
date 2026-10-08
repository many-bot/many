# manyreport

Plugin de report de bugs e sugestões pro ManyBot. Qualquer pessoa pode reportar um bug ou
mandar uma sugestão pelo próprio WhatsApp — a mensagem é reenviada direto para o número
configurado nas configurações do bot.

## Uso

    !bug o comando !video tá travando quando o link é do TikTok
    !sugestao seria legal ter um comando pra converter figurinha em imagem

(`!sugerir` também funciona como alias de `!sugestao`.)

Quem reportar recebe uma confirmação na hora, e o número configurado recebe uma mensagem
formatada com o conteúdo, se veio de grupo ou privado (sem nome/id do chat), o horário e as
últimas 10 mensagens de texto trocadas naquele chat, pra dar contexto — tudo sem nenhum dado
pessoal.

> **O report é anônimo.** Não vai nome, número, id do chat ou nome do grupo em lugar nenhum
> da mensagem enviada — nem nos logs. Ou seja: o admin recebe o problema/sugestão com
> contexto, mas não tem como saber quem mandou nem responder diretamente pra essa pessoa.

## Histórico de mensagens

O ManyBot ainda não tem um histórico de mensagens nativo no `ctx`, então o plugin guarda o
seu próprio, em memória, por chat:

- Só mensagens de **texto** entram (imagens, vídeos, áudios, figurinhas e documentos são
  ignorados).
- Mensagens que começam com o prefixo de comando (`!algo`) não entram — isso mantém o
  histórico focado em conversa real, e não polui com o próprio comando de report.
- **Nenhum dado pessoal é guardado** — só o texto da mensagem e o horário. Nome, número e
  id do chat/grupo não ficam guardados em lugar nenhum.
- Guarda só as últimas 10 por chat; a 11ª mensagem empurra a mais antiga pra fora.
- Fica em memória do processo — reinicia o bot, zera o histórico. Se precisar sobreviver a
  reinícios, dá pra trocar o `Map` por leitura/escrita em `ctx.storage`.

## Configuração

Adicione no `manybot.toml`:

| Chave            | Padrão | Descrição                                                                 |
| ---------------- | ------ | -------------------------------------------------------------------------- |
| `REPORT_NUMBER`  | —      | Número que recebe os reports. Só dígitos (`5511999999999`) ou JID completo (`5511999999999@s.whatsapp.net`). **Obrigatório.** |

Sem essa chave configurada, o plugin avisa no log ao carregar e responde a quem tentar
reportar dizendo que o recurso ainda não foi configurado.

## Instalação local

```bash
manyplug validate .
manyplug install --local .
```
