export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "search",
      description: "Search the web for current information. Use when you need up-to-date facts, news, or anything a knowledge cutoff wouldn't cover.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_history",
      description: "Search the chat's message history for past conversations or information shared earlier.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for in history" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mem_read",
      description: "Search saved facts for this chat. There is no fixed key/value store — this does a free-text search over everything saved with mem_write. Use '*' to get everything.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search over saved facts, or '*' for everything" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mem_write",
      description: "Save a fact to memory for this chat. There is no key/value store — write one short, self-contained, factual note (e.g. 'user's name is Rafael'), not a key and a value.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Short, factual, third-person note to save" },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calc",
      description: "Evaluate a mathematical expression. Use for arithmetic, unit conversions, or any numeric computation.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "The mathematical expression to evaluate (e.g. '2 + 2', 'sqrt(144)')" },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "group_info",
      description: "Get information about the current group chat (participants count, name, description, etc.). Only works in groups.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_sticker",
      description: "Send a sticker to the chat. Use when the user asks for a specific sticker or when a sticker is the most appropriate reply.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The sticker name to send" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch",
      description: "Fetch the content of a web page. Use to read articles, documentation, or any online resource.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_search",
      description: "Search Wikipedia for article titles matching a query.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term for Wikipedia" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiki_fetch",
      description: "Fetch the full content of a Wikipedia article by its title.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The exact Wikipedia article title" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "index_search",
      description: "Search the local knowledge index for information. Use for documentation, guides, or internal knowledge base queries.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for the knowledge index" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill",
      description: "Load a skill module that provides additional capabilities. Skills contain specialized knowledge or instructions for specific tasks.",
      parameters: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The name of the skill to load" },
        },
        required: ["skill_name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_agent",
      description: "Interact with files in the sandbox. Supports actions: init, write, append, read, replace, list, checksum, mv, cp, mkdir, rm, zip, checkpoint, resume, deliver, clear. For content too large for one call, use write for the first chunk and append for the rest.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "The action to perform (write, append, read, replace, list, checksum, mv, cp, mkdir, rm, zip, checkpoint, resume, deliver, clear, init)" },
          session_id: { type: "string", description: "The sandbox session ID" },
          path: { type: "string", description: "File path within the sandbox (write/append/read/replace/list/checksum/mkdir/rm/checkpoint)" },
          content: { type: "string", description: "Plain UTF-8 text content for write/append — use this for ANY text file (html/css/js/json/csv/md/code/etc). Preferred over content_base64: chunks across multiple append calls just concatenate, nothing to misalign." },
          content_base64: { type: "string", description: "Base64-encoded content for write/append — only for genuinely binary data. If used across multiple chunks, each chunk's content_base64 must be the base64 of THAT chunk's own raw bytes, never a slice of one big base64 string cut by character position." },
          overwrite: { type: "boolean", description: "write: set true to replace a file that already has content (default false, which fails safely instead)" },
          encoding: { type: "string", description: "read: \"utf8\" (default) or \"base64\" for binary files" },
          search: { type: "string", description: "replace: literal text to find" },
          replace: { type: "string", description: "replace: literal text to substitute in" },
          out: { type: "string", description: "replace: output path (omit to overwrite the input path in place)" },
          src: { type: "string", description: "mv/cp: source path" },
          dst: { type: "string", description: "mv/cp: destination path" },
          dest: { type: "string", description: "zip: output .zip path" },
          paths: { type: "array", items: { type: "string" }, description: "zip: list of sandbox paths to include" },
          send: { type: "boolean", description: "zip: set true to deliver the zip to the chat immediately, no separate deliver call needed" },
          filename: { type: "string", description: "zip/deliver: filename to present to the user (optional)" },
          data: { type: "object", description: "checkpoint: small JSON object of progress to save" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transcribe_audio",
      description: "Transcribe the audio/voice note attached to the current message (or the message it's replying to). Use whenever you need to know what a voice note says — nothing is transcribed automatically.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_image",
      description: "Analyze the image attached to the current message (or the message it's replying to). Use when you need to look at an image the user sent — describe it, read text in it, answer a question about it.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What to look for or answer about the image (optional — omit for a general description)" },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];

export const TOOL_NAME_MAP = {
  search: "SEARCH",
  search_history: "SEARCH_HISTORY",
  mem_read: "MEM_READ",
  mem_write: "MEM_WRITE",
  calc: "CALC",
  group_info: "GROUP_INFO",
  send_sticker: "SEND_STICKER",
  fetch: "FETCH",
  wiki_search: "WIKI_SEARCH",
  wiki_fetch: "WIKI_FETCH",
  index_search: "INDEX_SEARCH",
  skill: "SKILL",
  file_agent: "FILE_AGENT",
  transcribe_audio: "TRANSCRIBE_AUDIO",
  analyze_image: "ANALYZE_IMAGE",
};

