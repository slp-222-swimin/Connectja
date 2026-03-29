# Connectja

Connectja は、Supabase Realtime を使って複数人で同時編集できる TJA エディタです。  
ブラウザ版（Vite）と、Windows 向け Electron 版の両方をサポートしています。

## 主な機能
- リアルタイム共同編集（ノート/コマンド）
- TJA Source 編集（Monaco Editor）
- `.tja` のエクスポート / インポート（インポートはファイルアップロード方式）
- BPM / HS / MEASURE / GOGOSTART / GOGOEND 編集
- 音源アップロード（`.ogg`）と波形表示
- 再生シーク、マグネット吸着、履歴ジャンプ（Undo/Redo履歴）
- ノートヒット演出、連打/風船中の専用アニメーション

## 技術スタック
- React 18 + TypeScript
- Vite
- Tailwind CSS
- Monaco Editor
- Supabase
- Electron（デスクトップ版）

## 必要環境
- Node.js 18+
- npm
- Supabase プロジェクト

## セットアップ
```bash
npm install
```

`.env` を作成:
```env
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

## 開発（Web）
```bash
npm run dev
```

## ビルド（Web）
```bash
npm run build
npm run preview
```

## Electron 版（Windows）
### 開発起動
```bash
npm run electron:dev
```

### 配布ビルド（インストーラー生成）
```bash
npm run electron:dist
```

補足:
- Electron 配布ビルドは `vite build --mode electron`（`base: ./`）で実行されます。
- 生成物は `release/` 配下に出力されます。
- Releases に載せるのは通常 `Connectja Setup *.exe` のみでOKです。

## アイコン
- Electron アイコンは `logo.ico` を使用します。
- `electron/main.mjs` と `package.json (build.icon / win.icon)` に設定済みです。

## Supabase マイグレーション
`supabase/migrations/` の SQL を順に適用してください。
- `add_audio_support.sql`
- `add_chart_volume_fields.sql`
- `add_gogo_commands.sql`
- `add_room_events.sql`
- `add_room_password.sql`

## ディレクトリ概要
- `src/components/Editor.tsx` : メインエディタ
- `src/components/Lobby.tsx` : ルーム選択画面
- `src/lib/tjaConverter.ts` : GUI/TJA 変換
- `src/lib/AudioEngine.ts` : 再生 / SE / スケジューラ
- `electron/main.mjs` : Electron メインプロセス

## 操作ガイド
詳細は [howToUse.md](./howToUse.md) を参照してください。
