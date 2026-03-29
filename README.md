# Connectja

Connectja は、Supabase Realtime を使って複数人で同時編集できる TJA スコアエディタです。  
Monaco Editor ベースの TJA ソース編集と、キャンバス表示による視覚的な編集を組み合わせています。

## Features

- リアルタイム共同編集
- Monaco Editor ベースの TJA ソース編集
- キャンバス上でのノート配置とプレビュー
- BPM, HS, SCROLL, MEASURE, GOGOSTART, GOGOEND などのコマンド対応
- `.tja` のインポート / エクスポート
- Supabase Storage を使った音源アップロード
- ドラッグ操作とマウスホイールによる快適な編集

## Tech Stack

- React 18 + TypeScript
- Vite
- Tailwind CSS
- Monaco Editor
- Supabase
- Web Audio API

## Prerequisites

- Node.js 18 以上
- npm
- Supabase プロジェクト

## Setup

```bash
npm install
```

`.env` に Supabase の接続情報を設定します。

```env
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

## Development

```bash
npm run dev
```

ローカルで `http://localhost:5173` を開いて動作確認します。

## Production Build

```bash
npm run build
```

ビルド成果物は `dist/` に出力されます。

プレビュー確認をしたい場合は次を実行します。

```bash
npm run preview
```

## Supabase Schema

`supabase/migrations/` に以下のマイグレーションがあります。

- `add_audio_support.sql`
- `add_chart_volume_fields.sql`
- `add_gogo_commands.sql`
- `add_room_events.sql`
- `add_room_password.sql`

これらを Supabase に適用してから利用してください。

## Project Structure

- `src/components/Editor.tsx` - メインのエディタ画面
- `src/components/Lobby.tsx` - ルーム一覧と参加 UI
- `src/lib/tjaConverter.ts` - GUI と TJA 文字列の相互変換
- `src/lib/tjaLanguage.ts` - Monaco 用の TJA 言語定義
- `src/lib/AudioEngine.ts` - 再生と SE 制御
- `supabase/migrations/` - DB スキーマとマイグレーション

## Notes

- 本番環境では `.env` を GitHub に含めないでください
- 音源を使う機能には Supabase Storage の `audio` バケットが必要です
- 共同編集機能には Realtime と各テーブルの RLS 設定が必要です

## User Guide

より詳しい使い方は [`howToUse.md`](./howToUse.md) を参照してください。
