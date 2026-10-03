## 推奨する体験

1. 学習言語・レベル・場面を選ぶ
   例：韓国語／初級／スーパーで買い物
2. LLMと対象言語だけでチャット
3. 言い方が分からなければ「どう言えばいい？」を押す
4. 日本語または英語で言いたかった内容を入力
5. アプリが自然な対象言語表現を提案
6. その会話ブロック全体をワンタップで保存
7. 後からフラッシュカードとして復習

カードは単なる単語帳にせず、次の形がいい。

| 表面               | 裏面                        |
| ---------------- | ------------------------- |
| 直前の会話＋「ここで何と言う？」 | 自然な表現、LLMの返答、意味、短い文法説明、音声 |

内部には以下を保存する。

```text
context
intendedMeaning
learnerAttempt
naturalExpression
assistantReply
translation
shortExplanation
language
difficulty
```

会話履歴はアプリ終了時に消してもよい一方、**保存したLearning MomentだけSQLiteへ永続化**する。以前の「セッション中だけ記憶」という方針とも両立する。

## iPhone用モデル

第一候補は **Qwen3-0.6Bの4bit量子化版**。モデルカード上では0.6B本体、100以上の言語・方言、チャット、thinking/non-thinking切替に対応している。会話練習では `/no_think` 相当で動かし、余計な推論を減らすのがよい。[Qwen3-0.6B model card](https://huggingface.co/Qwen/Qwen3-0.6B)

iPhone 16 Proなら、以下の設定で余裕を持たせられる可能性が高い。

* 4bit量子化
* コンテキスト：2,048〜4,096 tokens
* 履歴：直近6〜8メッセージ
* 返答：最大100〜150 tokens
* thinking無効
* ストリーミング表示

重みは理論上約300MBで、ランタイム、KVキャッシュなどを含めると実使用メモリはもっと増えるが、0.6B級なら現実的。ただし「多言語対応」と「韓国語が自然」は別問題なので、実機で韓国語・英語・日本語それぞれ50プロンプト程度の評価セットを作るべき。

iOS実装は **SwiftUI＋MLX Swift** を推す。公式サンプルにはiOS/macOS対応のLLMチャットと、Hugging Faceからモデルを取得して実行する例がある。[MLX Swift examples](https://github.com/ml-explore/mlx-swift-examples)

MLC LLMもiPhone向けSwift API、モデルのアプリ同梱、コンテキスト制限などに対応しているが、最初はApple環境との親和性が高いMLX Swiftのほうが進めやすい。[MLC iOS SDK](https://llm.mlc.ai/docs/deploy/ios.html)

## 開発順序

以前の案どおり、まずPC上で挙動を固めてからiPhoneへ移すのがよい。

### Phase 1：ブラウザMVP

* TypeScript
* FastAPI
* Ollama＋Qwen3-0.6B Q4
* チャット
* 「どう言えばいい？」機能
* 会話ブロック保存
* フラッシュカード一覧

### Phase 2：学習機能

* SQLite
* 復習間隔管理
* 正解・難しい・忘れた評価
* ブロック読み上げ
* Speech-to-Text
* カード検索とタグ

### Phase 3：iPhone完全オフライン化

* SwiftUI
* MLX Swift
* Qwen3-0.6B Q4
* Apple Speech
* `AVSpeechSynthesizer`
* SwiftDataまたはSQLite

推論部分は最初から次のように抽象化しておく。

```swift
protocol LLMProvider {
    func streamReply(messages: [ChatMessage]) -> AsyncThrowingStream<String, Error>
}
```

これならOllama、MLX、クラウドAPIを交換できる。

## FDEポートフォリオとして強くする要素

完成アプリだけでなく、次をGitHubに残すとFDEらしくなる。

* 5〜10人へのユーザーインタビュー
* 「どこで言葉に詰まったか」という課題定義
* 最初のUIからフィードバック後に何を変えたか
* ローカルLLMとクラウドLLMの比較
* TTFT、tokens/sec、RAM、発熱、バッテリー消費
* 韓国語会話の品質評価
* 不正な構造化出力、モデル読み込み失敗などのフォールバック
* アーキテクチャ図とデモ動画

つまり、これは「LLMを載せたチャットアプリ」ではなく、**顧客の実際の詰まりを発見し、モデル・モバイル・データ・UXを統合して解決した事例**として仕上げる。それならFDE志望と非常に相性がいい。

次に作るべきものは、ブラウザ版の4画面――`Setup / Chat / Saved Cards / Review`――とデータモデル。ここから実装を始められる。
