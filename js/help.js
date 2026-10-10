// 不需登入也能查看的手機操作說明。
const help = document.createElement('dialog');
help.id = 'feature-help'; help.className = 'study-dialog feature-help';
help.setAttribute('aria-labelledby', 'feature-help-title');
help.innerHTML = `
  <form method="dialog" class="study-heading"><h2 id="feature-help-title">功能說明</h2><button class="btn">關閉</button></form>
  <p>從拍照、相簿或語音開始，老師會依內容選擇教法。</p>
  <div class="help-cards">
    <section><h3>拍題目，一步一步解</h3><p>數學、自然、語文等題目都可以。照片有多項內容時，先選想學的那一項；也能檢查手寫答案。</p></section>
    <section><h3>拍文章，聽懂重點</h3><p>導讀文章、解釋段落與難詞，再整理重點。看不懂時，按「追問」請老師換個方式說。</p></section>
    <section><h3>拍單字，聽原文發音</h3><p>看意思、用法與例句，按播放聽朗讀。按「聲音」可開關旁白；管理員能設定聲線、語速及英式／美式發音。</p></section>
    <section><h3>直接說題目，也能打字</h3><p>按「語音」說「請解釋光合作用」或完整題目。先檢查辨識文字，再送出；不支援語音的手機仍可打字。</p></section>
    <section><h3>指定範圍，老師考你</h3><p>例如「考我國中常用單字，5 題」或「出 3 題一元一次方程式」。選測驗後逐題回答，可用說的；老師批改、給提示並整理錯題。</p><p class="entry-note">每次 1～10 題。若要對應特定課本，請提供年級、章節或單字清單。進行中的測驗刷新後會清除，完成後可在「學習經歷」複習。</p></section>
    <section><h3>複習、追問與練習</h3><p>黑板下方可上一步、播放、下一步；「重點」快速看完整內容。「學習經歷」可重播講解、收藏和複習錯題；有學習內容時，黑板下方的「工具」提供收藏、標記、提示與出題。「標記」將教材列為待複習，「提示」引導逐步思考，「出題」提供同觀念練習。</p></section>
    <section><h3>許願新功能</h3><p>按首頁「許願功能」，用文字提出想增加的功能與使用情境。管理員會收到並列為待開發考量，送出不代表已排定開發。</p></section>
  </div>`;
document.body.append(help);
document.getElementById('open-help').addEventListener('click', () => help.showModal());
