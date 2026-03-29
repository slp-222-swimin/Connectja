# Connectja

Connectja は、React + TypeScript と Supabase Realtime を使って実装された、リアルタイム協調編集ができる TJA リズム譜エディタです。
複数のユーザーが同時に同じチャートを編集し、音源のアップロード／プレビュー、音符やコマンドの配置、そして標準的な `.tja` ファイルとしてのエクスポートが行えます。

**技術スタック**

- React 18 + TypeScript
- Vite
- Tailwind CSS
- Monaco Editor（TJA ソース編集）
- Supabase（Postgres + Realtime + Storage）
- Web Audio API（再生と SE スケジューリング）

**主な機能**

- Supabase Realtime によるノート／コマンドのリアルタイム共同編集
- Monaco ベースの TJA ソースエディタ（独自の言語定義とテーマあり）
- Canvas ベースの譜面プレビュー（シークバー、他ユーザーのカーソル表示、波形表示）
- 対応コマンド：`BPM`、`HS`（`SCROLL`）、`MEASURE`、`GOGOSTART`、`GOGOEND`
- `.tja` へエクスポート（エクスポート後にデータを全削除するオプションでストレージの音源も削除可能）
- ルーム単位の音源アップロード・削除（Supabase Storage）
- ドラッグ時の自動スクロール（エッジ近接で継続スクロール）
- プレビュー上でのマウスホイールによる水平スクロール

**クイックスタート**

前提:

- Node.js 18 以上と npm / yarn
- Supabase プロジェクト（`rooms`, `notes`, `commands` テーブルと適切な RLS/パブリケーション）

開発用に動かす:

```bash
npm install
npm run dev
```

本番ビルド:

```bash
npm run build
npm run preview
```

**重要なファイル**

- `src/components/Editor.tsx` — メインのエディタ UI、Canvas 描画、操作ハンドラ
- `src/components/Lobby.tsx` — ルーム選択 UI
- `src/lib/tjaConverter.ts` — GUI 状態と `.tja` テキストの相互変換
- `src/lib/tjaLanguage.ts` — Monaco の言語定義とトークンルール
- `src/lib/AudioEngine.ts` — WebAudio を使った再生・SE スケジューラ
- `supabase/migrations/` — DB スキーマ / マイグレーション

**保守者向けメモ**

- 内部的に 1 小節を 96 分割（グリッド解像度）で扱います。
- Monaco のトークン定義により、ヘッダー行（TITLE, BPM など）の値が本文のノートトークンとして色付けされないようにしています。
- エクスポート時に「エクスポート後に削除」を選ぶと、Supabase Storage の音源ファイル（`${roomId}.ogg`）も削除されます。

**コントリビュート**

- ローカルで動作確認し、`http://localhost:5173` を開いて動作を検証してください。
- 変更を加える際は `npm run lint` と `npm run build` を実行してから PR を出してください。

---

ユーザー向けの簡易ガイドは `howToUse.md` を参照してください。