/**
 * TJA Language Definition for Monaco Editor
 * Provides syntax highlighting for TJA chart files.
 */
import type { languages } from 'monaco-editor'

export const TJA_LANGUAGE_ID = 'tja'

export const tjaLanguageConfig: languages.LanguageConfiguration = {
  comments: {
    lineComment: '//'
  },
  brackets: [],
  autoClosingPairs: [],
}

export const tjaTokensProvider: languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      // Comments
      [/\/\/.*$/, 'comment'],

      // Chart commands (inside #START..#END)
      [/#(START|END)\b/, 'keyword.control'],
      [/#(BPMCHANGE|SCROLL|MEASURE|DELAY|GOGOSTART|GOGOEND|BARLINEOFF|BARLINEON|BRANCHSTART|BRANCHEND|N|E|M|LYRIC)\b/, 'keyword.command'],

      // Header lines - entire line is treated as a single token to prevent internal highlighting
      [/^(TITLE|SUBTITLE|BPM|WAVE|OFFSET|DEMOSTART|GENRE|MAKER|COURSE|LEVEL|BALLOON|SCOREINIT|SCOREDIFF|SCOREMODE|SONGVOL|SEVOL|HEADSCROLL|STYLE|EXAM1|EXAM2|EXAM3|GOGOSTART|GOGOEND)\s*:[^\n]*/, 'string'],

      // Measure end comma
      [/,$/, 'delimiter.comma'],

      // Note characters (inside chart data)
      [/[1]/, 'note.don'],          // Don (red)
      [/[2]/, 'note.ka'],           // Ka (blue)
      [/[3]/, 'note.bigdon'],       // Big Don
      [/[4]/, 'note.bigka'],        // Big Ka
      [/[5]/, 'note.roll'],         // Roll start
      [/[6]/, 'note.bigroll'],      // Big roll start
      [/[79]/, 'note.balloon'],      // Balloon / Kusudama
      [/[8]/, 'note.end'],          // End marker
      [/[9]/, 'note.kusudama'],     // Kusudama
      [/[0]/, 'note.empty'],        // Empty

      // Numbers (for header values)
      [/\d+(\.\d+)?/, 'number'],

      // Strings
      [/[^\s,#/:0-9][^\n]*/, 'string'],
    ]
  }
}

export const tjaThemeRules = [
  { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
  { token: 'keyword.control', foreground: 'C586C0', fontStyle: 'bold' },
  { token: 'keyword.command', foreground: 'DCDCAA', fontStyle: 'bold' },
  { token: 'delimiter.comma', foreground: '808080' },
  { token: 'note.don', foreground: 'FF4D4D', fontStyle: 'bold' },       // Red
  { token: 'note.ka', foreground: '4D94FF', fontStyle: 'bold' },        // Blue
  { token: 'note.bigdon', foreground: 'FF6B6B', fontStyle: 'bold' },    // Light red
  { token: 'note.bigka', foreground: '6BAAFF', fontStyle: 'bold' },     // Light blue
  { token: 'note.roll', foreground: 'FFCC00', fontStyle: 'bold' },      // Yellow
  { token: 'note.bigroll', foreground: 'FFD700', fontStyle: 'bold' },   // Gold
  { token: 'note.balloon', foreground: 'FF9900', fontStyle: 'bold' },   // Orange
  { token: 'note.end', foreground: '888888' },                          // Gray
  { token: 'note.kusudama', foreground: 'FF69B4', fontStyle: 'bold' },  // Pink
  { token: 'note.empty', foreground: '333333' },                        // Dark gray
  { token: 'number', foreground: 'B5CEA8' },
  { token: 'string', foreground: 'CE9178' },
]
