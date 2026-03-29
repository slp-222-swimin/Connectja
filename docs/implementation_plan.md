# 音響・リアルタイムコラボレーション拡張 実装計画

本計画では、Connectjaエディタに「音楽アップロードと波形表示」「SE付きクライアント再生」「ユーザー名の登録と他者のシークバー表示」の3つの主要機能を追加します。

## 1. データベース＆ストレージの準備

1. **Supabase Storage** にパブリックバケット `audio` を作成。
2. `rooms` テーブルに `audio_url` カラム（TEXT）を追加。
   - すでに作成済みの場合はマイグレーションSQLで追加。
3. `public/snd/` フォルダに `don.mp3` と `ka.mp3` を配置する（アセット準備）。

## 2. ユーザー名入力と参加/退出の処理 (Presence機能)

### [MODIFY] [src/App.tsx](file:///c:/Users/rikur/Documents/connectja/src/App.tsx) または [src/components/Lobby.tsx](file:///c:/Users/rikur/Documents/connectja/src/components/Lobby.tsx)
- ルーム一覧に入る前、もしくはエディタに入る前に「ユーザー名」を入力させるモーダルを追加。
- ユーザー名とカラー（ランダム生成）を `localStorage` に保存。

### [MODIFY] [src/components/Editor.tsx](file:///c:/Users/rikur/Documents/connectja/src/components/Editor.tsx)
- **Presenceの利用**: Supabaseの `channel.track({ userId, userName, color, seekPos })` を使用。
- エディタ入室時にPresenceに `join`、退室時に `leave`。
- `channel.on('presence', { event: 'sync' })` で他クライアントの状態（`presenceState`）をReactステートに保存。

## 3. 他人シークバーの名前付き色別半透明表示

### [MODIFY] [src/components/Editor.tsx](file:///c:/Users/rikur/Documents/connectja/src/components/Editor.tsx) (Canvas Rendering)
- `presenceState` に保存された他のユーザーの `seekPos` を取得。
- [getX(measure, pos)](file:///c:/Users/rikur/Documents/connectja/src/components/Editor.tsx#134-142) で座標を計算し、Canvas上にユーザー固有の `color` で半透明の縦線（シークバー）を描画。
- 縦線の上部に `userName` のテキストボックスを合わせて描画する。

## 4. 音源アップロードとGUI/Spaceキー再生機能

### [MODIFY] [src/components/Editor.tsx](file:///c:/Users/rikur/Documents/connectja/src/components/Editor.tsx)
- **メタデータ欄にアップロードUI**: 「Upload Audio」ボタンを追加し、`supabase.storage` に `audio/${roomId}/...` としてアップロード。完了後に `rooms.audio_url` を更新。
- **AudioContextの初期化**: 
  - `audio_url` が変更されたら [fetch](file:///c:/Users/rikur/Documents/connectja/src/components/Lobby.tsx#21-38) して `AudioContext.decodeAudioData` で `AudioBuffer` に変換。
  - 同時に [snd/don.mp3](file:///c:/Users/rikur/Documents/connectja/snd/don.mp3), [snd/ka.mp3](file:///c:/Users/rikur/Documents/connectja/snd/ka.mp3) もフェッチしてバッファに保持。
- **再生/停止 (Play/Stop)**:
  - `Space` キー押下、またはGUIのPlayボタンでトグル（クライアントローカルのみ）。
  - 再生時: 現在の `seekPos`（小節単位）から該当するオーディオの秒数を計算し `AudioBufferSourceNode` をスタート。
  - `requestAnimationFrame` または `setInterval` を用いて、実際の `AudioContext.currentTime` から現在の `seekPos` を逆算し、自身のシークバーを自動進行させる。シーク位置が動くことでPresence経由で他クライアントにもブロードキャストされる（デバウンス付）。

## 5. 譜面下部の波形(Waveform)表示

### [MODIFY] [src/components/Editor.tsx](file:///c:/Users/rikur/Documents/connectja/src/components/Editor.tsx) (Canvas Rendering)
- `AudioBuffer` の `getChannelData(0)` からピーク配列（min/max）を抽出。解像度はキャンバスの横幅ピクセル数に合わせるか、一定のチャンクごとにダウンサンプリング。
- Canvasの `LANE_HEIGHT` の下部に数十ピクセルの波形描画エリアを設ける（`WAVEFORM_HEIGHT`）。
- `measureOffsets` に基づき、現在の横スクロール位置に対応する波形スライスをキャンバスに描画（例：半透明の白などで塗りつぶし）。

## 6. SE（効果音）のスケジュール再生

再生中、キャンバスの進行に合わせてWeb Audio APIを用いてジャストタイミングでSEを予約・発音させます。

### 発音ロジック (AudioScheduler)
- 再生開始時やシーク時に、少し先（例えば数小節先）までのノートを先読み（Lookahead）。
- 指定されたテンポ（BPMやMEASURE）から、各ノートの絶対時間（秒）を計算。
- **1, 3 (ドン系)**: `don.mp3` をスケジュール (`audioCtx.createBufferSource().start(time)`)
- **2, 4 (カッ系)**: `ka.mp3` をスケジュール
- **5, 6 (連打)**:
  - 終点(8)までの時間を計算。
  - 始点から終点まで `20ms` (0.02秒) 間隔で `don.mp3` をスケジュールするループを実行。
- **7 (風船)**:
  - 属性の `hits` (打数) を取得（デフォルト5）。
  - 始点から `5ms` (0.005秒) 間隔で `don.mp3` を `hits` 回分スケジュール。
- （重い処理にならないよう、定期的な `setInterval` ワーカー等で「あと数秒後に鳴るべき音」を数秒ごとにAudioContextに予約していく仕組みを構築）

---

### 次のアクション

1. `rooms` テーブルへの `audio_url` カルム追加 (SQL)。
2. `public/snd/` にダミーの `don.mp3`, `ka.mp3` を用意（またはURL指定）。
3. ユーザー名入力・Lobby改修・Presence同期の実装。
4. オーディオロジック (Waveform + Playback + SE Scheduler) の搭載。

以上の計画で実装へ進んでよろしいでしょうか？
