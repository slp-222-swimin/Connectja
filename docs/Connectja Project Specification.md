# 🥁 Connectja (コネクチャ) - React Edition Specification

**Connectja** = **Connect** + **TJA**
> 「Reactで加速する、次世代型TJAリアルタイム共同編集エディタ」

---

## 🌈 1. プロジェクト概要

- **目的**: 複数人がブラウザ上で同一のTJA譜面をリアルタイム編集・プレビューできる環境。
- **運営規模**: 最大 3ルーム (Room A/B/C) / 1部屋最大4名
- **主要技術**:
  - **Frontend**: React, Tailwind CSS, Canvas API
  - **Backend**: Supabase (Auth, Realtime, Database, Storage)

---

## 🚀 2. 主要機能一覧

### 🔵 エディタ基本機能
- **96分割グリッド**: 内部解像度一律96。UIスナップ（8, 16, 24, 48分）。
- **音符定義 (TJA準拠)**:
  - `1`: ドン, `2`: カッ, `3`: 大ドン, `4`: 大カッ
  - `5`: 連打始, `6`: 大連打始, `7/9`: 風船始
  - `8`: 終了（連打・風船）, `0`: 空白

### 🛠️ 高度な編集GUI
- **複数選択**: `Ctrl + Click` による個別選択、マウスドラッグによる矩形選択。
- **変形操作**: 選択音符の一括ドラッグ移動、連打終点(8)の伸縮ハンドル。
- **履歴管理**: `Ctrl + Z` (Undo) / `Ctrl + Y` (Redo) のスタック管理。
- **属性編集**: 風船音符の `hits` (打数) 変更用プロパティインスペクタ。

### 🤝 リアルタイム同期
- **衝突解決**: ミリ秒 timestamp による **Last Write Wins (LWW)**。
- **Presence**: 他者のマウス位置・選択範囲をキャンバス上に可視化。

---

## 🗂️ 3. データベース・システム構造 (SQL)

Supabaseの SQL Editor で以下のスクリプトを実行して環境を構築します。

```sql
-- 1. ルーム管理テーブル
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, -- 'room-a', 'room-b', 'room-c'
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 音符データテーブル (96分割基準)
CREATE TABLE notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  measure INTEGER NOT NULL,      -- 小節番号
  position INTEGER NOT NULL,     -- 0-95
  type TEXT NOT NULL,            -- '1'-'9'
  attributes JSONB DEFAULT '{}', -- {"hits": 10} 等
  last_modified_at BIGINT NOT NULL, -- LWW判定用タイムスタンプ(ms)
  user_id UUID DEFAULT auth.uid(),
    
  -- 同一ルームの同一箇所には1つのレコードのみ (UPSERT用)
  UNIQUE(room_id, measure, position)
);

-- 3. 初期ルームの作成
INSERT INTO rooms (id, display_name) VALUES 
('room-a', '梅の間'),
('room-b', '竹の間'),
('room-c', '松の間')
ON CONFLICT (id) DO NOTHING;

-- 4. リアルタイム機能を有効化 (Publication)
ALTER PUBLICATION supabase_realtime ADD TABLE notes;

-- 5. RLS (Row Level Security) の設定
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- 全ユーザーに読み取り許可
CREATE POLICY "Allow public read rooms" ON rooms FOR SELECT USING (true);
CREATE POLICY "Allow public read notes" ON notes FOR SELECT USING (true);

-- 認証済みユーザーまたは匿名ユーザーに書き込み許可 (デモ用)
CREATE POLICY "Allow all to insert/update notes" ON notes 
  FOR ALL USING (true) WITH CHECK (true);
```

---

## 🎨 4. コンポーネント構成

- **Lobby**: ルーム選択と参加人数表示。
- **EditorContainer**: 全体のレイアウト管理（サイドバー・ツールバー含む）。
- **CanvasArea**: `requestAnimationFrame` を用いた譜面レンダリング。
- **PropertyInspector**: 選択中の音符（特に風船）の属性編集。

---

## 🛠️ 5. 開発フェーズ

- **Phase 1**: React + Canvas の基本描画とスナップ（8/16/24/48分）。
- **Phase 2**: 複数選択、ドラッグ移動、Undo/Redoの実装。
- **Phase 3**: Supabase Realtime (Broadcast/Presence) 連携とLWW同期。

**Connectja - Rhythm connects us.**