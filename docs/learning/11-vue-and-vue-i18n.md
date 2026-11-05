# Vue 支援與 vue-i18n

你的 portfolio 是 Nuxt 4，介面都寫在 `.vue` 檔裡，之前的規則只看得懂 `.tsx`。這一輪讓工具看懂 Vue：

- **`.vue` 檔裡寫死的字串**：你把介面字串搬進翻譯檔時，它會告訴你還有哪些沒搬
- **vue-i18n 的訊息語法**：你的翻譯檔會用 `@nuxtjs/i18n`，它的語法跟其他 i18n 套件不一樣，有幾個地方很容易寫錯

程式碼在 `packages/core/src/vue/sfc.ts`、`packages/core/src/locale/vue-i18n.ts`，以及 `no-hardcoded-string`、`intl-format`、`locale-placeholders` 三條規則。

## 這一輪完成了什麼

- `no-hardcoded-string` 支援 `.vue`：template 的文字、`placeholder` 這類會顯示的屬性，以及 `{{ }}`、`:title`、`v-text`、`v-html` 裡的字串
- `intl-format` 支援 `.vue`：`<script>` 和 template 的運算式都檢查，`{{ price.toFixed(2) }}`、`NT$ {{ price }}` 也會抓
- 只有網址、路徑、email、帳號、檔名的字串（`/resume.pdf`、`@grayson`、`read.cv`）不再回報，JSX 也一樣
- 新設定 `ignoreText`、`ignorePattern`：品牌名稱這種不翻譯的字串
- vue-i18n 專案的翻譯檔用 vue-i18n 官方編譯器解析：編譯不過的訊息回報成 error，並說明怎麼修
- 測試：221 → 252 個

## 實際驗證了什麼

- 在 portfolio 的 30 多個 `.vue` 檔上跑，第一次找到 130 個寫死的字串，逐一檢查分類（見概念 3）
- 模擬 portfolio 裝了 `@nuxtjs/i18n` 之後的翻譯檔：抓到 email 那行編譯不過，也抓到中英文的變數名稱不一致，正確的 `{'@'}` 寫法沒有誤報
- 突變測試：把 4 個關鍵邏輯分別改壞，每一個都有測試失敗

---

## 概念 1：Vue 單檔元件是三種語言

```vue
<template>          ← HTML（加上 Vue 的語法）
  <p :title="hint">{{ price.toFixed(2) }}</p>
</template>

<script setup lang="ts">   ← TypeScript
const hint = "Price"
</script>

<style>             ← CSS
</style>
```

解析交給 Vue 官方的 `@vue/compiler-dom`，跟 Nuxt 用的是同一個 parser、同一個版本（3.5.44），所以工具看到的結構跟你的網站完全一樣。用 `parseMode: "sfc"` 解析時，最外層的 `<script>`、`<style>` 內容會被當成純文字，只有 `<template>` 會被解析成節點，每個節點都帶有原始檔案的行號和位置。

## 概念 2：影子檔案

`intl-format` 是為 TypeScript 寫的，裡面用 ts-morph 分析語法樹。要讓它看懂 `.vue`，有兩個選擇：

1. 為 Vue 重寫一份規則：維護兩份一樣的邏輯，遲早會不一致
2. **把 `.vue` 轉成 TypeScript**，讓原本的規則直接跑

我選了第 2 種，做法是產生一個「影子」檔：

```
原始 .vue                               影子 .ts（長度完全相同）
<template>                              ··········
  <p :title="hint">{{ price.toFixed(2) }}</p>      ··········;(hint)··;(price.toFixed(2)))····
</template>                             ···········
<script setup lang="ts">                ························
const hint = "Price"                    const hint = "Price"
</script>                               ·········
```

（`·` 代表空白）

- `<script>` 的內容原封不動放在原本的位置
- template 裡的每個運算式也放在原本的位置，前面的 `{{` 或 `="` 換成 `;(`，後面一個字元換成 `)`，變成一行合法的 TypeScript
- 其他所有字元都換成空白，**換行保留**

所以影子檔的第 N 行第 M 欄，就是 `.vue` 的第 N 行第 M 欄，規則回報的位置不用任何換算。這跟筆記 10 處理 front matter 的技巧是同一個想法：**保留位置，把不相干的東西換成空白**。

`toFixed()` 只有「顯示在畫面上」時才該報，例如 JSX 的 `{price.toFixed(2)}`。在 Vue 裡，影子檔會記住哪些運算式來自 `{{ }}`、`v-text`、`v-html` 和會顯示的屬性，規則就用這個判斷。所以 `:width="(w * 2).toFixed(1)"` 這種 SVG 座標不會被報，你的程式碼裡這種寫法很多。

## 概念 3：用真實的元件校正規則

第一次在 portfolio 上跑，找到 130 個寫死的字串。我把每一個都看過，分成三類：

| 類型 | 例子 | 處理 |
|---|---|---|
| 真的要翻譯的介面文字 | `No comments yet.`、`Sign in with GitHub →`、`aria-label="Search"`、`{{ sending ? 'Sending…' : 'Send →' }}` | 回報 |
| 只是網址、路徑、帳號 | `/resume.pdf`、`@grayson`、`read.cv` | **工具自動跳過**（5 個） |
| 品牌、你決定不翻的 | `Grayson's Portfolio.`、`grayson`、`EN`、`— 06 / about` | 用設定排除 |

第二類任何專案都不該報，所以修在工具裡；第三類只有你知道，所以做成設定。這是規則設計的一個原則：**工具判斷得了的，工具自己處理；判斷不了的，讓使用者設定，而且設定要容易寫。**

`ignoreText`、`ignorePattern` 這兩個名稱，沿用 vue-i18n 官方 ESLint 外掛（`@intlify/vue-i18n/no-raw-text`）的命名，用過那個外掛的人不用重新學。

另外，`<script>` 裡的字串不檢查，例如 `useMobileNav.ts` 的 `label: 'projects'`。原因跟 JSX 規則一樣：script 裡的字串很多是 key、CSS class、路由名稱，全部報出來會太吵。這是刻意的取捨：**寧可漏報，不要誤報**。

## 概念 4：vue-i18n 不是 ICU

`{name}` 在 react-intl（ICU）和 vue-i18n 裡長得一模一樣，所以很容易以為它們是同一種語法。其實不是：

| | ICU（react-intl、next-intl） | vue-i18n |
|---|---|---|
| 變數 | `{name}` | `{name}`、`{0}` |
| 複數 | `{count, plural, one {# item} other {# items}}` | `no apples \| one apple \| {count} apples` |
| 特殊字元 | `{` `}` `'` | `{` `}` `@` `$` `\|` |
| 字面值 | `'{'` | `{'@'}`，或 v11.3 之後的 `\@` |
| 連結其他 key | 無 | `@:common.appName`、`@.lower:key` |

最容易踩到的就是 `@`：

```json
{ "email": "email · graysonlin512@gmail.com" }
```

vue-i18n 看到 `@` 會以為後面是連結訊息（`@:key`），結果編譯失敗，網站上會顯示 key 而不是文字。你的 about 頁就有這行，搬進翻譯檔時一定會遇到。

所以工具在 vue-i18n 專案裡，直接用 **vue-i18n 官方的編譯器**（`@intlify/message-compiler`）解析每一則訊息：它判斷錯誤，就跟你的網站執行時一模一樣，不用自己猜規則。這跟前面用 ts-morph、Vue compiler、Markdown parser 是同一個原則。

### 怎麼知道專案用 vue-i18n？

從翻譯檔往上找最近的 `package.json`，看依賴裡有沒有 `vue-i18n`、`@nuxtjs/i18n`、`petite-vue-i18n`。找最近的而不是根目錄的，是因為 monorepo 裡每個 app 可能用不同的 i18n 套件。

同一個 email 字串，在 React 專案裡是正常文字，在 vue-i18n 專案裡是錯誤。測試裡兩種情況都有，確保「判斷專案」這一步真的有作用。

## 概念 5：查官方文件

vue-i18n 的特殊字元有哪些、`\@` 跳脫字元從哪一版開始支援，這些我都先查了[官方文件的 Message Format Syntax](https://vue-i18n.intlify.dev/guide/essentials/syntax.html)，再用編譯器實際跑一次確認。例如文件寫特殊字元包含 `$`，但實測 `cost: $5` 可以正常編譯，所以工具不會報它，**以編譯器的實際行為為準**。

---

## 動手做

### 建議的 `.l10nrc.yml`

照你的決定（品牌和小寫英文標籤維持英文），portfolio 可以這樣設定：

```yaml
sourceLocale: zh-TW
ignore:
  - app/pages/playground.vue          # 元件展示頁，不是給訪客看的
rules:
  no-hardcoded-string:
    # 品牌名稱：中英文版都維持英文
    ignoreText:
      - "Grayson's Portfolio."
      - "grayson"
      - "grayson / 2026"
      - "EN"
      - "github"
      - "N° 2026 — 04"
      - "grayson 26.10.26"
      - "© 2026 — grayson · index 00"
    ignorePattern: '^— \d+ / '         # 區塊標籤，例如「— 06 / about」
  content-parity:
    pairs:
      - source: content/blog
        translations:
          en: content/i18n/en/blog
```

套用之後還剩 97 個寫死的字串，加上 1 個文章不一致。其中 21 個是單一的小寫英文字，例如 `close`、`menu`、`search`、`email`、`now`、`previously`、`location`。這些如果也要維持英文，可以把 `ignorePattern` 改成：

```yaml
    ignorePattern: '^(— \d+ / |[a-z.]+$)'
```

但要小心：`close`、`menu`、`search` 是按鈕和螢幕閱讀器會念的文字，中文版的使用者可能更需要中文。

### 搬字串的流程

1. 安裝 `@nuxtjs/i18n`，建立 `i18n/locales/zh-TW.json`、`en.json`
2. 一個頁面一個 PR：把那頁的字串搬進翻譯檔，template 改成 `{{ $t('about.now') }}`
3. PR 上 l10n-review 會告訴你這頁還有哪些沒搬，以及翻譯檔有沒有寫錯
4. 那 97 個會越來越少

## Laravel 對照表

| 這一輪 | Laravel |
|---|---|
| `{{ $t('about.now') }}` | `{{ __('about.now') }}` |
| vue-i18n `{name}` | `:name` |
| vue-i18n 複數 `one apple \| {count} apples` | `trans_choice('apples', $n)`，翻譯檔一樣用 `\|` 分隔 |
| 連結訊息 `@:common.name` | Laravel 沒有，要在程式裡組 |
| 影子檔案的做法 | Blade 也會先編譯成 PHP 檔（`storage/framework/views`），PHP 工具才看得懂 |

最後一列是同一個概念：Blade 不是 PHP，所以 Laravel 先把它編譯成 PHP；Vue template 不是 TypeScript，所以工具先把它轉成 TypeScript。

## 動手練習

1. **套用設定**：把上面的 `.l10nrc.yml` 放進 portfolio，在本機跑 `node ../ai-platform/packages/cli/src/cli.ts --all`，確認剩下的數字。
2. **修 about 頁的 email**：搬進翻譯檔時，email 要寫成 `{'@'}`，還是乾脆不放進翻譯檔？兩種做法各有什麼好處？
3. **新規則的設計題**：`$t('about.nwo')` 這種打錯的 key，現在的工具抓不到。要怎麼找出「程式碼裡用到、但翻譯檔沒有的 key」？（提示：影子檔裡 `$t(...)` 的第一個參數是字串字面值；動態的 key，例如 `` $t(`nav.${name}`) `` 要怎麼處理？）
4. **script 裡的字串**：`useMobileNav.ts` 的 `label: 'projects'` 會顯示在導覽列上，但工具不檢查 script。如果要檢查，要怎麼避免把 key、class 名稱也報出來？
5. **思考題**：vue-i18n 的 `|` 是複數分隔符號，所以 `"About | Grayson"` 會被當成兩個複數形式，畫面上可能只出現 `About`。但 `"car | cars"` 是正確的複數寫法。工具要怎麼分辨這兩種？
