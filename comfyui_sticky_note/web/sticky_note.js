import { app } from "../../scripts/app.js";

// ==================== Theme ====================
const C = {
    bg: "#1c1c1e",
    bgLight: "#252830",
    bgDark: "#161618",
    surface: "#3a3a3c",
    surfaceHover: "#48484a",
    border: "#48484a",
    borderLight: "#636366",
    text: "#f5f5f7",
    textMuted: "#8e8e93",
    accent: "#5E9EFC",
    accentHover: "#7CB2FD",
    accentGlow: "rgba(94,158,252,0.35)",
    shadow: "rgba(0,0,0,0.55)"
};

// ==================== State ====================
let editorEl = null, overlayEl = null, currentNode = null;
let isDraggingEditor = false, dragOffsetX = 0, dragOffsetY = 0;
let savedRange = null;
let editorPos = null;

// ==================== Utils ====================
function restoreSelection() {
    if (savedRange) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
    }
}

function isCJK(ch) {
    const code = ch.charCodeAt(0);
    return (code >= 0x4E00 && code <= 0x9FFF) ||
           (code >= 0x3400 && code <= 0x4DBF) ||
           (code >= 0x3000 && code <= 0x303F) ||
           (code >= 0xFF00 && code <= 0xFFEF) ||
           (code >= 0x3040 && code <= 0x309F) ||
           (code >= 0x30A0 && code <= 0x30FF) ||
           (code >= 0xAC00 && code <= 0xD7AF);
}

function splitTextIntoUnits(text) {
    const units = [];
    let currentWord = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (/\s/.test(ch)) {
            if (currentWord) { units.push(currentWord); currentWord = ""; }
            units.push(ch);
        } else if (isCJK(ch)) {
            if (currentWord) { units.push(currentWord); currentWord = ""; }
            units.push(ch);
        } else {
            currentWord += ch;
        }
    }
    if (currentWord) units.push(currentWord);
    return units;
}

function measureUnit(ctx, text, style, letterSpacing) {
    let s = "";
    if (style.bold) s += "bold ";
    if (style.italic) s += "italic ";
    s += style.fontSize + "px '" + style.fontFamily + "'";
    ctx.font = s;
    let w = 0;
    const ls = (letterSpacing === undefined || isNaN(letterSpacing)) ? 0 : letterSpacing;
    for (let i = 0; i < text.length; i++) {
        w += ctx.measureText(text[i]).width;
        if (i < text.length - 1) w += ls;
    }
    return isNaN(w) ? 0 : w;
}

function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// 遍历 HTML 中的每个文本节点，取它们实际渲染字号的最大值
function getEffectiveFontSize(html, baseFontSize) {
    const base = (baseFontSize && !isNaN(baseFontSize)) ? baseFontSize : 14;
    if (!html) return base;
    const temp = document.createElement("div");
    temp.innerHTML = html;
    let max = 0;
    function walk(node, currentSize) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (node.textContent && node.textContent.length > 0) {
                if (currentSize > max) max = currentSize;
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        let size = currentSize;
        if (node.tagName === "FONT" && node.getAttribute("size")) {
            const v = parseInt(node.getAttribute("size"));
            if (!isNaN(v)) size = v;
        }
        const st = node.getAttribute && node.getAttribute("style");
        if (st) {
            const m = st.match(/font-size:\s*([^;]+)/i);
            if (m) { const v = parseInt(m[1]); if (!isNaN(v)) size = v; }
        }
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], size);
    }
    walk(temp, base);
    return max > 0 ? max : base;
}

// 从 HTML 字符串中剥掉所有内联 font-size 和 <font size>（保留颜色、加粗等其他样式）
function stripInlineFontSizes(html) {
    if (!html) return "";
    // 1. 去掉 style 属性里的 font-size:xxx; 片段
    html = html.replace(/font-size\s*:\s*[^;"]+;?/gi, "");
    // 2. 清理只剩空 style="" 的属性
    html = html.replace(/\s+style\s*=\s*(["'])\s*\1/gi, "");
    // 3. 清理 <font size="...">
    html = html.replace(/(<font\b[^>]*?)\s+size\s*=\s*(["'])[^"']*\2/gi, "$1");
    return html;
}

// 简单字符串散列，用于内容签名
function hashStr(s) {
    s = s || "";
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
}

// 给选区套一个带新样式的 span，并剥掉选区内同名的旧样式
function applyStyleToRange(range, cssProp, cssValue) {
    const span = document.createElement("span");
    span.style[cssProp] = cssValue;
    try { range.surroundContents(span); } catch(err) {
        const frag = range.extractContents(); span.appendChild(frag); range.insertNode(span);
    }
    // 遍历 span 内所有带 style 的元素，清掉同属性的内联样式
    const targets = span.querySelectorAll("[style]");
    for (let i = 0; i < targets.length; i++) {
        const el = targets[i];
        if (el.style && el.style[cssProp]) el.style[cssProp] = "";
    }
    if (cssProp === "fontSize") {
        const fonts = span.querySelectorAll("font[size]");
        for (let i = 0; i < fonts.length; i++) fonts[i].removeAttribute("size");
    }
    return span;
}

// ==================== 尺寸计算 ====================
function calcMinNodeWidth(fontSize) {
    const f = (fontSize && !isNaN(fontSize)) ? fontSize : 14;
    return Math.max(200, Math.round(f * 2.5 + 60));
}

function measureContentHeight(html, innerWidth, style) {
    const m = document.createElement("div");
    m.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;left:-99999px;top:0;box-sizing:border-box;";
    m.style.width = Math.max(innerWidth, 20) + "px";
    m.style.fontFamily = (style.fontFamily || "Microsoft YaHei") + ", sans-serif";
    m.style.fontSize = (style.fontSize || 14) + "px";
    m.style.lineHeight = (style.lineHeight !== undefined ? style.lineHeight : 1.4);
    m.style.letterSpacing = (style.letterSpacing !== undefined ? style.letterSpacing : 0) + "px";
    m.style.wordBreak = "break-word";
    m.style.overflowWrap = "break-word";
    m.style.whiteSpace = "normal";
    m.innerHTML = html || "";
    document.body.appendChild(m);
    const h = m.offsetHeight;
    document.body.removeChild(m);
    return h || 0;
}

const HARD_MIN_W = 40;
const HARD_MIN_H = 30;

// ==================== HTML -> Canvas Engine ====================
function parseHtmlToTokens(container, baseStyle) {
    const tokens = [];
    function walk(node, style, listContext) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) tokens.push({ text, style: Object.assign({}, style), listIndent: listContext.indent || 0 });
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();
        const newStyle = Object.assign({}, style);
        if (tag === "b" || tag === "strong") newStyle.bold = true;
        else if (tag === "i" || tag === "em") newStyle.italic = true;
        else if (tag === "u") newStyle.underline = true;
        else if (tag === "s" || tag === "strike" || tag === "del") newStyle.strike = true;
        else if (tag === "span") {
            const st = node.getAttribute("style") || "";
            const cm = st.match(/color:\s*([^;]+)/i); if (cm) newStyle.color = cm[1].trim();
            const sm = st.match(/font-size:\s*([^;]+)/i); if (sm) {
                const v = parseInt(sm[1]); if (!isNaN(v)) newStyle.fontSize = v;
            }
            const fm = st.match(/font-family:\s*([^;]+)/i); if (fm) newStyle.fontFamily = fm[1].trim().replace(/['"]/g, "");
            const lsm = st.match(/letter-spacing:\s*([^;]+)/i); if (lsm) {
                const v = parseFloat(lsm[1]); if (!isNaN(v)) newStyle.letterSpacing = v;
            }
            const lhm = st.match(/line-height:\s*([^;]+)/i);
            if (lhm) {
                const v = parseFloat(lhm[1]); if (!isNaN(v)) newStyle.lineHeight = v;
            }
        } else if (tag === "font") {
            const fc = node.getAttribute("color"); if (fc) newStyle.color = fc;
            const face = node.getAttribute("face"); if (face) newStyle.fontFamily = face;
            const sz = node.getAttribute("size"); if (sz) {
                const v = parseInt(sz); if (!isNaN(v)) newStyle.fontSize = v;
            }
        }
        let newListContext = Object.assign({}, listContext);
        if (tag === "ul" || tag === "ol") {
            newListContext = { type: tag, level: (listContext.level || 0) + 1, count: 0, indent: listContext.indent || 0 };
        } else if (tag === "li") {
            listContext.count = (listContext.count || 0) + 1;
            const prefix = listContext.type === 'ul' ? "• " : (listContext.count + ". ");
            const indent = ((listContext.level || 0) - 1) * 20;
            tokens.push({ text: prefix, style: Object.assign({}, newStyle), isListPrefix: true, listIndent: indent });
            newListContext = Object.assign({}, listContext);
            newListContext.indent = indent;
        } else if (tag === "br") {
            tokens.push({ text: "", style: Object.assign({}, newStyle), isBreak: true, listIndent: 0 });
        }
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i], newStyle, newListContext);
        if (tag === "div" || tag === "p" || tag === "li") {
            if (tokens.length > 0 && !tokens[tokens.length - 1].isBreak)
                tokens.push({ text: "", style: Object.assign({}, newStyle), isBreak: true, listIndent: 0 });
        }
    }
    walk(container, baseStyle, { type: null, level: 0, count: 0, indent: 0 });
    return tokens;
}

function layoutTokensToLines(tokens, maxWidth, ctx, baseLetterSpacing) {
    const lines = [];
    let currentLine = [], currentLineWidth = 0, currentLineIndent = 0;
    function flushLine() {
        if (currentLine.length > 0) {
            lines.push({ tokens: currentLine, width: currentLineWidth, indent: currentLineIndent });
            currentLine = []; currentLineWidth = 0; currentLineIndent = 0;
        }
    }
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.isBreak) { flushLine(); continue; }
        const text = token.text;
        if (!text) continue;
        const ls = (token.style.letterSpacing !== undefined && !isNaN(token.style.letterSpacing))
            ? token.style.letterSpacing
            : ((baseLetterSpacing !== undefined && !isNaN(baseLetterSpacing)) ? baseLetterSpacing : 0);
        if (currentLine.length === 0) currentLineIndent = token.listIndent || 0;
        const units = splitTextIntoUnits(text);
        const effectiveMaxWidth = Math.max(maxWidth - currentLineIndent, 10);
        for (let j = 0; j < units.length; j++) {
            const unit = units[j];
            const unitWidth = measureUnit(ctx, unit, token.style, ls);
            if (!unitWidth || isNaN(unitWidth)) continue;
            if (currentLine.length > 0 && currentLineWidth + unitWidth > effectiveMaxWidth) {
                flushLine();
                currentLineIndent = token.listIndent || 0;
            }
            currentLine.push({ text: unit, style: token.style, width: unitWidth });
            currentLineWidth += unitWidth;
        }
    }
    flushLine();
    return lines;
}

function renderLines(ctx, lines, startX, startY, maxWidth, align, defaultLineHeight) {
    ctx.textBaseline = "top";
    let cy = startY;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let lineHeight = defaultLineHeight;
        for (let j = 0; j < line.tokens.length; j++) {
            const style = line.tokens[j].style;
            const lh = style.fontSize * ((style.lineHeight !== undefined && !isNaN(style.lineHeight)) ? style.lineHeight : 1.4);
            if (!isNaN(lh) && lh > lineHeight) lineHeight = lh;
        }
        let lineX = startX;
        const lineWidth = isNaN(line.width) ? 0 : line.width;
        if (align === "left") lineX = startX + (line.indent || 0);
        else if (align === "center") lineX = startX + (maxWidth - lineWidth) / 2;
        else if (align === "right") lineX = startX + (maxWidth - lineWidth);
        if (isNaN(lineX)) lineX = startX;

        let cx = lineX;
        for (let j = 0; j < line.tokens.length; j++) {
            const token = line.tokens[j];
            let s = "";
            if (token.style.bold) s += "bold ";
            if (token.style.italic) s += "italic ";
            s += token.style.fontSize + "px '" + token.style.fontFamily + "'";
            ctx.font = s;
            ctx.fillStyle = token.style.color || C.text;
            const text = token.text;
            const ls = (token.style.letterSpacing !== undefined && !isNaN(token.style.letterSpacing))
                ? token.style.letterSpacing : 0;
            for (let k = 0; k < text.length; k++) {
                const ch = text[k];
                if (!isNaN(cx)) ctx.fillText(ch, cx, cy);
                const chWidth = ctx.measureText(ch).width;
                cx += chWidth + (k < text.length - 1 ? ls : 0);
            }
        }
        cx = lineX;
        for (let j = 0; j < line.tokens.length; j++) {
            const token = line.tokens[j];
            const fontSize = token.style.fontSize;
            const tw = isNaN(token.width) ? 0 : token.width;
            if (token.style.underline || token.style.strike) {
                ctx.strokeStyle = token.style.color || C.text;
                ctx.lineWidth = Math.max(1, fontSize / 16);
                if (token.style.underline && !isNaN(cx)) {
                    ctx.beginPath();
                    ctx.moveTo(cx, cy + fontSize * 0.85 + 2);
                    ctx.lineTo(cx + tw, cy + fontSize * 0.85 + 2);
                    ctx.stroke();
                }
                if (token.style.strike && !isNaN(cx)) {
                    ctx.beginPath();
                    ctx.moveTo(cx, cy + fontSize * 0.45);
                    ctx.lineTo(cx + tw, cy + fontSize * 0.45);
                    ctx.stroke();
                }
            }
            cx += tw;
        }
        cy += lineHeight;
    }
    return cy;
}

function renderHtmlToCanvas(ctx, html, x, y, maxWidth, defaultLineHeight, baseStyle, defaultLetterSpacing, align) {
    if (!html) return y;
    const temp = document.createElement("div");
    temp.innerHTML = html;
    const tokens = parseHtmlToTokens(temp, baseStyle);
    const lines = layoutTokensToLines(tokens, maxWidth, ctx, defaultLetterSpacing);
    return renderLines(ctx, lines, x, y, maxWidth, align, defaultLineHeight);
}

// ==================== Markdown ====================
function processMarkdownInNode(textNode) {
    const text = textNode.textContent;
    const parent = textNode.parentNode;
    if (!parent) return false;
    const tag = parent.tagName;
    if (['B','I','U','S','STRONG','EM','STRIKE'].includes(tag)) return false;
    const patterns = [
        { regex: /\*\*(.+?)\*\*/g, tag: 'b' },
        { regex: /\*(.+?)\*/g, tag: 'i' },
        { regex: /__(.+?)__/g, tag: 'u' },
        { regex: /~~(.+?)~~/g, tag: 's' }
    ];
    for (const p of patterns) {
        const match = p.regex.exec(text);
        if (match) {
            const before = text.substring(0, match.index);
            const content = match[1];
            const after = text.substring(match.index + match[0].length);
            const fragment = document.createDocumentFragment();
            if (before) fragment.appendChild(document.createTextNode(before));
            const el = document.createElement(p.tag);
            el.textContent = content;
            fragment.appendChild(el);
            if (after) fragment.appendChild(document.createTextNode(after));
            parent.replaceChild(fragment, textNode);
            return true;
        }
    }
    return false;
}

function processListShortcuts(container) {
    const blocks = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.tagName === 'DIV' || node.tagName === 'P') blocks.push(node);
    }
    const textNodesToWrap = [];
    for (let i = 0; i < container.childNodes.length; i++) {
        const node = container.childNodes[i];
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) textNodesToWrap.push(node);
    }
    for (const node of textNodesToWrap) {
        const wrapper = document.createElement('div');
        container.insertBefore(wrapper, node);
        wrapper.appendChild(node);
        blocks.push(wrapper);
    }
    for (const block of blocks) {
        const text = block.textContent;
        const ulMatch = text.match(/^[-*]\s+(.*)$/);
        if (ulMatch && block.tagName !== 'LI') {
            const ul = document.createElement('ul');
            const li = document.createElement('li');
            li.textContent = ulMatch[1];
            ul.appendChild(li);
            block.parentNode.replaceChild(ul, block);
            return true;
        }
        const olMatch = text.match(/^(\d+)\.\s+(.*)$/);
        if (olMatch && block.tagName !== 'LI') {
            const ol = document.createElement('ol');
            const li = document.createElement('li');
            li.textContent = olMatch[2];
            ol.appendChild(li);
            block.parentNode.replaceChild(ol, block);
            return true;
        }
    }
    return false;
}

function applyMarkdownShortcuts(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let modified = false;
    while (walker.nextNode()) {
        if (processMarkdownInNode(walker.currentNode)) { modified = true; break; }
    }
    if (!modified) processListShortcuts(container);
}

// ==================== Editor ====================
function getEditor() {
    if (editorEl) return editorEl;

    overlayEl = document.createElement("div");
    overlayEl.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,12,18,0.72);backdrop-filter:blur(8px);z-index:99998;display:none;";
    overlayEl.addEventListener("mousedown", (e) => {
        if (e.target === overlayEl && currentNode) {
            saveToNode(currentNode);
            hideEditor();
            currentNode = null;
            app.canvas.setDirty(true, true);
        }
    });
    document.body.appendChild(overlayEl);

    editorEl = document.createElement("div");
    editorEl.id = "comfy-Sticky-note-editor";
    editorEl.style.cssText = `position:fixed;z-index:99999;background:${C.bg};border:1px solid ${C.border};border-radius:16px;box-shadow:0 0 0 1px rgba(94,158,252,0.08),0 32px 80px ${C.shadow};display:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;width:420px;height:520px;resize:both;overflow:hidden;flex-direction:column;min-width:320px;min-height:240px;`;

    const toolbar = document.createElement("div");
    toolbar.id = "crn-toolbar";
    toolbar.style.cssText = `padding:10px 14px;border-bottom:1px solid ${C.bgDark};display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:${C.bgDark};border-radius:16px 16px 0 0;cursor:move;user-select:none;flex-shrink:0;`;

    const fontSel = document.createElement("select");
    fontSel.id = "crn-font";
    fontSel.style.cssText = `background:${C.surface};color:${C.text};border:1px solid ${C.border};border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12px;outline:none;`;
    [["Microsoft YaHei","微软雅黑"],["SimSun","宋体"],["SimHei","黑体"],["KaiTi","楷体"],["FangSong","仿宋"],["Arial","Arial"]].forEach(f => {
        const opt = document.createElement("option");
        opt.value = f[0]; opt.textContent = f[1];
        fontSel.appendChild(opt);
    });
    toolbar.appendChild(fontSel);

    const sizeSel = document.createElement("select");
    sizeSel.id = "crn-size";
    sizeSel.style.cssText = `background:${C.surface};color:${C.text};border:1px solid ${C.border};border-radius:8px;padding:4px 8px;cursor:pointer;width:60px;font-size:12px;outline:none;`;
    [10,12,14,16,18,20,24,28,32,36,40,48,56,64,72,80,96,112,128,160,192,224,256,320,384,448,512,640,768,896,1024].forEach(s => {
        const opt = document.createElement("option");
        opt.value = s; opt.textContent = s;
        sizeSel.appendChild(opt);
    });
    sizeSel.value = "14";
    toolbar.appendChild(sizeSel);

    function addSep() {
        const sep = document.createElement("span");
        sep.textContent = "|";
        sep.style.cssText = `color:${C.border};margin:0 4px;font-size:11px;user-select:none;opacity:0.5;`;
        toolbar.appendChild(sep);
    }

    function createToolbarButton(html, id, isItalic) {
        const btn = document.createElement("button");
        btn.id = id; btn.innerHTML = html;
        btn.style.cssText = `width:28px;height:28px;background:${C.surface};color:${C.textMuted};border:1px solid ${C.border};border-radius:8px;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;transition:all 0.18s cubic-bezier(0.4,0,0.2,1);`;
        if (isItalic) btn.style.fontStyle = "italic";
        btn.addEventListener("mouseenter", function() {
            this.style.background = C.surfaceHover;
            this.style.color = C.accent;
            this.style.borderColor = "rgba(94,158,252,0.5)";
            this.style.boxShadow = `0 0 8px ${C.accentGlow}`;
            this.style.transform = "translateY(-1px)";
        });
        btn.addEventListener("mouseleave", function() {
            this.style.background = C.surface;
            this.style.color = C.textMuted;
            this.style.borderColor = C.border;
            this.style.boxShadow = "none";
            this.style.transform = "translateY(0)";
        });
        return btn;
    }

    const boldBtn = createToolbarButton("<b>B</b>", "crn-bold", true);
    const italicBtn = createToolbarButton("<i>I</i>", "crn-italic", true);
    const underlineBtn = createToolbarButton("<u>U</u>", "crn-underline", true);
    const strikeBtn = createToolbarButton("<s>S</s>", "crn-strike", true);
    toolbar.appendChild(boldBtn);
    toolbar.appendChild(italicBtn);
    toolbar.appendChild(underlineBtn);
    toolbar.appendChild(strikeBtn);

    addSep();

    const colorPick = document.createElement("input");
    colorPick.type = "color"; colorPick.id = "crn-color"; colorPick.value = "#e0e0f0";
    colorPick.style.cssText = "width:30px;height:24px;border:none;background:none;cursor:pointer;padding:0;";
    toolbar.appendChild(colorPick);

    addSep();

    const alignLeftBtn = createToolbarButton("⬅", "crn-align-left", false);
    alignLeftBtn.title = "左对齐";
    const alignCenterBtn = createToolbarButton("↔", "crn-align-center", false);
    alignCenterBtn.title = "居中对齐";
    const alignRightBtn = createToolbarButton("➡", "crn-align-right", false);
    alignRightBtn.title = "右对齐";
    toolbar.appendChild(alignLeftBtn);
    toolbar.appendChild(alignCenterBtn);
    toolbar.appendChild(alignRightBtn);

    addSep();

    const ulBtn = createToolbarButton("•", "crn-ul", false);
    ulBtn.title = "无序列表";
    const olBtn = createToolbarButton("1.", "crn-ol", false);
    olBtn.title = "有序列表";
    toolbar.appendChild(ulBtn);
    toolbar.appendChild(olBtn);

    addSep();

    const letterLabel = document.createElement("span");
    letterLabel.textContent = "字距:";
    letterLabel.style.cssText = `color:${C.textMuted};font-size:11px;user-select:none;`;
    toolbar.appendChild(letterLabel);
    const letterInput = document.createElement("input");
    letterInput.type = "number"; letterInput.id = "crn-letter"; letterInput.min = "-5"; letterInput.max = "100"; letterInput.step = "1"; letterInput.value = "0";
    letterInput.style.cssText = `width:44px;background:${C.surface};color:${C.text};border:1px solid ${C.border};border-radius:8px;padding:4px 8px;font-size:11px;outline:none;`;
    toolbar.appendChild(letterInput);

    const lineLabel = document.createElement("span");
    lineLabel.textContent = "行距:";
    lineLabel.style.cssText = `color:${C.textMuted};font-size:11px;user-select:none;`;
    toolbar.appendChild(lineLabel);
    const lineInput = document.createElement("input");
    lineInput.type = "number"; lineInput.id = "crn-line"; lineInput.min = "0.5"; lineInput.max = "10.0"; lineInput.step = "0.1"; lineInput.value = "1.4";
    lineInput.style.cssText = `width:44px;background:${C.surface};color:${C.text};border:1px solid ${C.border};border-radius:8px;padding:4px 8px;font-size:11px;outline:none;`;
    toolbar.appendChild(lineInput);

    addSep();

    const bgLabel = document.createElement("span");
    bgLabel.id = "crn-bg-label"; bgLabel.textContent = "背景:";
    bgLabel.style.cssText = `color:${C.textMuted};font-size:11px;user-select:none;`;
    toolbar.appendChild(bgLabel);
    const bgPick = document.createElement("input");
    bgPick.type = "color"; bgPick.id = "crn-bg"; bgPick.value = "#252830";
    bgPick.style.cssText = "width:30px;height:24px;border:none;background:none;cursor:pointer;padding:0;";
    toolbar.appendChild(bgPick);

    const alphaLabel = document.createElement("span");
    alphaLabel.id = "crn-alpha-label"; alphaLabel.textContent = "透明:";
    alphaLabel.style.cssText = `color:${C.textMuted};font-size:11px;user-select:none;`;
    toolbar.appendChild(alphaLabel);
    const alphaSlider = document.createElement("input");
    alphaSlider.type = "range"; alphaSlider.id = "crn-alpha"; alphaSlider.min = "0"; alphaSlider.max = "100"; alphaSlider.value = "100";
    alphaSlider.style.cssText = `width:56px;cursor:pointer;accent-color:${C.accent};`;
    toolbar.appendChild(alphaSlider);
    const alphaVal = document.createElement("span");
    alphaVal.id = "crn-alpha-val"; alphaVal.textContent = "100%";
    alphaVal.style.cssText = `color:${C.textMuted};font-size:11px;min-width:34px;user-select:none;`;
    toolbar.appendChild(alphaVal);

    addSep();

    const fullTransCheck = document.createElement("input");
    fullTransCheck.type = "checkbox"; fullTransCheck.id = "crn-full-trans";
    fullTransCheck.style.cssText = `cursor:pointer;margin:0;accent-color:${C.accent};`;
    const fullTransLabel = document.createElement("label");
    fullTransLabel.style.cssText = `color:${C.textMuted};font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;user-select:none;`;
    fullTransLabel.appendChild(fullTransCheck);
    fullTransLabel.appendChild(document.createTextNode("完全透明"));
    toolbar.appendChild(fullTransLabel);

    const okBtn = document.createElement("button");
    okBtn.id = "crn-ok"; okBtn.textContent = "确认";
    okBtn.style.cssText = `margin-left:auto;background:${C.accent};color:#fff;border:none;padding:6px 18px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:500;transition:all 0.2s cubic-bezier(0.4,0,0.2,1);box-shadow:0 0 16px rgba(94,158,252,0.25);`;
    okBtn.addEventListener("mouseenter", function() {
        this.style.background = C.accentHover;
        this.style.transform = "translateY(-1px)";
        this.style.boxShadow = "0 0 24px rgba(94,158,252,0.45)";
    });
    okBtn.addEventListener("mouseleave", function() {
        this.style.background = C.accent;
        this.style.transform = "translateY(0)";
        this.style.boxShadow = "0 0 16px rgba(94,158,252,0.25)";
    });
    toolbar.appendChild(okBtn);

    editorEl.appendChild(toolbar);

    const content = document.createElement("div");
    content.id = "crn-content"; content.contentEditable = true;
    content.style.cssText = `padding:18px;flex:1;min-height:0;overflow:auto;outline:none;color:${C.text};font-size:14px;line-height:1.6;background:${C.bg};border:none;letter-spacing:0px;scrollbar-width:thin;scrollbar-color:${C.accent} ${C.bg};`;
    editorEl.appendChild(content);

    document.body.appendChild(editorEl);

    const listStyle = document.createElement("style");
    listStyle.textContent = "#crn-content ol, #crn-content ul { list-style-position: inside; padding-left: 0; margin-left: 0; text-align: inherit; } #crn-content li { text-align: inherit; }";
    document.head.appendChild(listStyle);

    const scrollStyle = document.createElement("style");
    scrollStyle.textContent = `#crn-content::-webkit-scrollbar { width:6px; } #crn-content::-webkit-scrollbar-track { background:transparent; } #crn-content::-webkit-scrollbar-thumb { background:${C.border}; border-radius:3px; } #crn-content::-webkit-scrollbar-thumb:hover { background:${C.accent}; border-radius:3px; }`;
    document.head.appendChild(scrollStyle);

    toolbar.addEventListener("mousedown", (e) => {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) savedRange = sel.getRangeAt(0).cloneRange();
        else savedRange = null;
        const tag = e.target.tagName;
        if (tag === "BUTTON" || tag === "SELECT" || tag === "INPUT" || tag === "LABEL") return;
        isDraggingEditor = true;
        const rect = editorEl.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        editorEl.style.transform = "none";
        editorEl.style.left = rect.left + "px";
        editorEl.style.top = rect.top + "px";
    });

    document.addEventListener("mousemove", (e) => {
        if (!isDraggingEditor || !editorEl) return;
        editorEl.style.left = (e.clientX - dragOffsetX) + "px";
        editorEl.style.top = (e.clientY - dragOffsetY) + "px";
    });
    document.addEventListener("mouseup", () => { isDraggingEditor = false; });

    boldBtn.onclick = (e) => { e.preventDefault(); restoreSelection(); document.execCommand("bold"); content.focus(); };
    italicBtn.onclick = (e) => { e.preventDefault(); restoreSelection(); document.execCommand("italic"); content.focus(); };
    underlineBtn.onclick = (e) => { e.preventDefault(); restoreSelection(); document.execCommand("underline"); content.focus(); };
    strikeBtn.onclick = (e) => { e.preventDefault(); restoreSelection(); document.execCommand("strikeThrough"); content.focus(); };

    alignLeftBtn.onclick = (e) => { e.preventDefault(); content.style.textAlign = "left"; content.focus(); };
    alignCenterBtn.onclick = (e) => { e.preventDefault(); content.style.textAlign = "center"; content.focus(); };
    alignRightBtn.onclick = (e) => { e.preventDefault(); content.style.textAlign = "right"; content.focus(); };

    ulBtn.onclick = (e) => { e.preventDefault(); restoreSelection(); document.execCommand("insertUnorderedList"); content.focus(); };
    olBtn.onclick = (e) => { e.preventDefault(); restoreSelection(); document.execCommand("insertOrderedList"); content.focus(); };

    fontSel.onchange = (e) => {
        e.preventDefault(); restoreSelection();
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && !sel.isCollapsed) {
            const range = sel.getRangeAt(0);
            const span = applyStyleToRange(range, "fontFamily", "'" + fontSel.value + "'");
            const newRange = document.createRange(); newRange.selectNodeContents(span);
            sel.removeAllRanges(); sel.addRange(newRange);
        }
        content.focus();
    };

    // ============ 字号下拉：清掉全部内联字号，然后设置编辑器默认字号 ============
    // 这样无论之前用多大字号（含内联 span 的 font-size），改小后立即生效
    sizeSel.onchange = (e) => {
        e.preventDefault();
        const newSize = parseInt(sizeSel.value);
        if (isNaN(newSize) || newSize < 1) return;
        // 1. 清掉整个编辑区所有内联 font-size / <font size>
        content.innerHTML = stripInlineFontSizes(content.innerHTML);
        // 2. 设置编辑区默认字号
        content.style.fontSize = newSize + "px";
        // 3. 同步到节点，让节点尺寸立即跟随
        if (currentNode) {
            const props = currentNode.properties || {};
            props.fontSize = newSize;
            currentNode.properties = props;
            if (currentNode._stickyUpdateDisplay) currentNode._stickyUpdateDisplay();
        }
        content.focus();
    };

    colorPick.oninput = (e) => {
        e.preventDefault(); restoreSelection();
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && !sel.isCollapsed) document.execCommand("foreColor", false, colorPick.value);
        content.focus();
    };

    alphaSlider.oninput = () => {
        alphaVal.textContent = alphaSlider.value + "%";
        if (currentNode && !fullTransCheck.checked) {
            const props = currentNode.properties || {};
            props.bgAlpha = (100 - parseInt(alphaSlider.value)) / 100;
            currentNode.properties = props;
            if (currentNode._stickyUpdateDisplay) currentNode._stickyUpdateDisplay();
        }
    };

    letterInput.addEventListener("input", () => applyStyleToSelectionOrGlobal("letterSpacing", (parseFloat(letterInput.value) || 0) + "px"));
    lineInput.addEventListener("input", () => applyStyleToSelectionOrGlobal("lineHeight", parseFloat(lineInput.value) || 1.4));

    content.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const sel = window.getSelection();
            if (sel.rangeCount > 0) {
                let node = sel.getRangeAt(0).startContainer;
                let inList = false;
                while (node && node !== content) {
                    if (node.tagName === 'LI') { inList = true; break; }
                    node = node.parentNode;
                }
                if (!inList) {
                    e.preventDefault();
                    const range = sel.getRangeAt(0);
                    const br = document.createElement("br");
                    range.deleteContents();
                    range.insertNode(br);
                    range.setStartAfter(br);
                    range.setEndAfter(br);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            }
        }
        if (e.key === "Escape") { e.preventDefault(); okBtn.click(); }
        if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); okBtn.click(); }
    });

    content.addEventListener("keyup", (e) => {
        if (e.key === " " || e.key === "Enter") setTimeout(() => applyMarkdownShortcuts(content), 0);
    });

    function updateBgControls() {
        const checked = fullTransCheck.checked;
        bgPick.disabled = checked; alphaSlider.disabled = checked;
        const dimColor = checked ? "#555558" : C.textMuted;
        bgLabel.style.color = dimColor;
        alphaLabel.style.color = dimColor;
        alphaVal.style.color = dimColor;
        alphaVal.textContent = alphaSlider.value + "%";
        if (currentNode) {
            const props = currentNode.properties || {};
            if (checked) props.bg_color = "transparent";
            else { props.bg_color = bgPick.value; props.bgAlpha = (100 - parseInt(alphaSlider.value)) / 100; }
            currentNode.properties = props;
            if (currentNode._stickyUpdateDisplay) currentNode._stickyUpdateDisplay();
        }
    }
    fullTransCheck.addEventListener("change", updateBgControls);
    bgPick.oninput = () => {
        if (currentNode && !fullTransCheck.checked) {
            const props = currentNode.properties || {};
            props.bg_color = bgPick.value;
            currentNode.properties = props;
            if (currentNode._stickyUpdateDisplay) currentNode._stickyUpdateDisplay();
        }
    };

    okBtn.onclick = () => {
        if (!currentNode) return;
        saveToNode(currentNode);
        hideEditor();
        currentNode = null;
        app.canvas.setDirty(true, true);
    };

    editorEl._updateBgControls = updateBgControls;
    return editorEl;
}

function applyStyleToSelectionOrGlobal(cssProp, cssValue) {
    restoreSelection();
    const sel = window.getSelection();
    let range = null;
    if (sel.rangeCount > 0 && !sel.isCollapsed) range = sel.getRangeAt(0);
    const content = editorEl.querySelector("#crn-content");
    if (range) {
        const span = applyStyleToRange(range, cssProp, cssValue);
        const newRange = document.createRange(); newRange.selectNodeContents(span);
        sel.removeAllRanges(); sel.addRange(newRange);
    } else {
        content.style[cssProp] = cssValue;
    }
}

function saveToNode(node) {
    const editor = getEditor();
    const props = node.properties || {};
    props.text = editor.querySelector("#crn-content").innerHTML;
    props.fontFamily = editor.querySelector("#crn-font").value;
    const rawFS = parseInt(editor.querySelector("#crn-size").value);
    const uiFS = (!isNaN(rawFS) && rawFS > 0) ? rawFS : 14;
    // 以内容里实际出现的最大字号作为 props.fontSize
    const effFS = getEffectiveFontSize(props.text || "", uiFS);
    props.fontSize = effFS;
    props.letterSpacing = parseFloat(editor.querySelector("#crn-letter").value) || 0;
    props.lineHeight = parseFloat(editor.querySelector("#crn-line").value) || 1.4;
    props.textAlign = editor.querySelector("#crn-content").style.textAlign || "left";
    const isTrans = editor.querySelector("#crn-full-trans").checked;
    if (isTrans) props.bg_color = "transparent";
    else {
        props.bg_color = editor.querySelector("#crn-bg").value;
        props.bgAlpha = (100 - parseInt(editor.querySelector("#crn-alpha").value)) / 100;
    }
    node.properties = props;
    if (node._stickyUpdateDisplay) node._stickyUpdateDisplay();
}

function loadFromNode(node) {
    const editor = getEditor();
    const props = node.properties || {};
    const contentEl = editor.querySelector("#crn-content");

    // 加载时就把历史遗留的内联 font-size 清洗掉，
    // 否则会出现"下拉框显示 18 但编辑器里还是 128"的错乱
    const cleanHtml = stripInlineFontSizes(props.text || "");
    contentEl.innerHTML = cleanHtml;
    contentEl.style.fontSize = (props.fontSize || 14) + "px";
    contentEl.style.textAlign = props.textAlign || "left";

    editor.querySelector("#crn-font").value = props.fontFamily || "Microsoft YaHei";
    editor.querySelector("#crn-size").value = String(props.fontSize || 14);
    editor.querySelector("#crn-color").value = props.fontColor || "#e0e0f0";
    editor.querySelector("#crn-letter").value = String(props.letterSpacing !== undefined ? props.letterSpacing : 0);
    editor.querySelector("#crn-line").value = String(props.lineHeight !== undefined ? props.lineHeight : 1.4);
    const isTrans = (props.bg_color === "transparent");
    editor.querySelector("#crn-full-trans").checked = isTrans;
    editor.querySelector("#crn-bg").value = isTrans ? "#252830" : (props.bg_color || "#252830");
    const alpha = Math.round((1.0 - (props.bgAlpha !== undefined ? props.bgAlpha : 0.0)) * 100);
    editor.querySelector("#crn-alpha").value = String(alpha);
    editor.querySelector("#crn-alpha-val").textContent = alpha + "%";
    if (editor._updateBgControls) editor._updateBgControls();
}

function showEditor() {
    getEditor();
    overlayEl.style.display = "block";
    editorEl.style.display = "flex";
    if (editorPos) {
        editorEl.style.transform = "none";
        editorEl.style.left = editorPos.left + "px";
        editorEl.style.top = editorPos.top + "px";
    } else {
        editorEl.style.left = "50%";
        editorEl.style.top = "50%";
        editorEl.style.transform = "translate(-50%, -50%)";
    }
    setTimeout(() => editorEl.querySelector("#crn-content").focus(), 50);
}

function hideEditor() {
    if (editorEl) {
        const rect = editorEl.getBoundingClientRect();
        editorPos = { left: rect.left, top: rect.top };
    }
    if (overlayEl) overlayEl.style.display = "none";
    if (editorEl) editorEl.style.display = "none";
}

// ==================== DOM Widget (ComfyUI 2.0) ====================
function createStickyDOMWidget(node) {
    const wrap = document.createElement("div");
    wrap.id = "sticky-note-dom-" + node.id;
    wrap.style.cssText = "width:100%;height:100%;padding:10px;box-sizing:border-box;overflow:hidden;border-radius:8px;pointer-events:auto;position:relative;";

    node._stickyDOMWrap = wrap;
    node._stickyResizing = false;
    node._stickyLastSig = undefined;

    node._stickyUpdateDisplay = function() {
        const props = this.properties || {};
        const fontSize = props.fontSize || 14;
        const fontFamily = props.fontFamily || "Microsoft YaHei";
        const fontColor = props.fontColor || "#e0e0f0";
        const bgColor = props.bg_color || "#252830";
        const bgAlpha = props.bgAlpha !== undefined ? props.bgAlpha : 1.0;
        const letterSpacing = props.letterSpacing !== undefined ? props.letterSpacing : 0;
        const lineHeight = props.lineHeight !== undefined ? props.lineHeight : 1.4;
        const textAlign = props.textAlign || "left";

        // 渲染前先清洗内联 font-size，保证节点显示和 props.fontSize 一致
        const cleanHtml = stripInlineFontSizes(props.text || "");

        wrap.innerHTML = cleanHtml;
        wrap.style.fontFamily = fontFamily + ", sans-serif";
        wrap.style.fontSize = fontSize + "px";
        wrap.style.color = fontColor;
        wrap.style.letterSpacing = letterSpacing + "px";
        wrap.style.lineHeight = lineHeight;
        wrap.style.textAlign = textAlign;
        wrap.style.wordBreak = "break-word";
        wrap.style.overflowWrap = "break-word";
        wrap.style.whiteSpace = "normal";
        wrap.style.maxWidth = "100%";
        wrap.style.maxHeight = "100%";

        if (bgColor === "transparent") {
            wrap.style.background = "transparent";
            this.bgcolor = "transparent";
        } else {
            const r = parseInt(bgColor.slice(1,3), 16);
            const g = parseInt(bgColor.slice(3,5), 16);
            const b = parseInt(bgColor.slice(5,7), 16);
            wrap.style.background = "rgba(" + r + "," + g + "," + b + "," + bgAlpha + ")";
            this.bgcolor = "transparent";
        }

        // ========== 内容或样式变化时自动同步节点宽度与高度 ==========
        const effFontSize = getEffectiveFontSize(props.text || "", fontSize);
        const sig = [effFontSize, fontFamily, letterSpacing, lineHeight, textAlign, hashStr(props.text || "")].join("|");
        const sigChanged = (this._stickyLastSig !== undefined) && (sig !== this._stickyLastSig);
        this._stickyLastSig = sig;
        if (sigChanged && !this._stickyResizing) {
            const self = this;
            requestAnimationFrame(() => {
                const targetW = calcMinNodeWidth(effFontSize);
                const innerW = Math.max(targetW - 20, 30);
                const contentH = measureContentHeight(cleanHtml, innerW, {
                    fontFamily: fontFamily,
                    fontSize: fontSize,
                    lineHeight: lineHeight,
                    letterSpacing: letterSpacing
                });
                const targetH = Math.max(contentH + 24, HARD_MIN_H);

                if (self.size && (Math.abs(self.size[0] - targetW) > 1 || Math.abs(self.size[1] - targetH) > 1)) {
                    self._stickyResizing = true;
                    try {
                        if (typeof self.setSize === "function") {
                            self.setSize([targetW, targetH]);
                        } else {
                            self.size[0] = targetW;
                            self.size[1] = targetH;
                        }
                    } finally {
                        self._stickyResizing = false;
                    }
                    try { app.canvas.setDirty(true, true); } catch (e) {}
                }
            });
        }

        try { app.canvas.setDirty(true, true); } catch (e) {}
    };

    node._stickyUpdateDisplay();
    return wrap;
}

// ==================== Extension ====================
app.registerExtension({
    name: "ComfyUI.StickyNote",

    async nodeCreated(node, app) {
        if (node.comfyClass !== "StickyNote") return;
        if (!node.addDOMWidget) return;
        node.resizable = true;

        node.onDrawForeground = function(ctx) {
            if (this.flags.collapsed) return;
            if (app.canvas.selected_nodes[this.id]) {
                ctx.save();
                roundRectPath(ctx, -2, -2, this.size[0]+4, this.size[1]+4, 10);
                ctx.strokeStyle = "rgba(94,158,252,0.5)";
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.restore();
            }
        };

        try { node.title_mode = LiteGraph.NO_TITLE; } catch(e) {}
        node.title = "";

        const p = node.properties || {};
        p.text = p.text ?? "双击编辑";
        p.fontFamily = p.fontFamily ?? "Microsoft YaHei";
        p.fontSize = p.fontSize ?? 14;
        p.fontColor = p.fontColor ?? "#e0e0f0";
        p.bg_color = p.bg_color ?? "#252830";
        p.bgAlpha = p.bgAlpha ?? 1.0;
        p.letterSpacing = p.letterSpacing ?? 0;
        p.lineHeight = p.lineHeight ?? 1.4;
        p.textAlign = p.textAlign ?? "left";
        if (p.fullTransparent === true) { p.bg_color = "transparent"; delete p.fullTransparent; }
        node.properties = p;

        if (!node.size || node.size[0] < 10) {
            const initW = calcMinNodeWidth(p.fontSize);
            const initInnerW = Math.max(initW - 20, 30);
            const initContentH = measureContentHeight(stripInlineFontSizes(p.text || ""), initInnerW, {
                fontFamily: p.fontFamily, fontSize: p.fontSize,
                lineHeight: p.lineHeight, letterSpacing: p.letterSpacing
            });
            node.size = [Math.max(240, initW), Math.max(initContentH + 24, 60)];
        }

        const domEl = createStickyDOMWidget(node);
        node.addDOMWidget("sticky_content", "sticky_content", domEl, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => HARD_MIN_H,
            getMaxHeight: () => 10000,
            getMinWidth: () => HARD_MIN_W,
            getMaxWidth: () => 10000,
        });

        domEl.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            if (node._stickyDragCleanup) { node._stickyDragCleanup(); node._stickyDragCleanup = null; }
            app.canvas.node_dragged = node;
            app.canvas.dragging_canvas = false;
            const startX = e.clientX, startY = e.clientY;
            const nodeStartX = node.pos[0], nodeStartY = node.pos[1];
            const scale = app.canvas.ds.scale;
            function onMove(ev) {
                node.pos[0] = nodeStartX + (ev.clientX - startX) / scale;
                node.pos[1] = nodeStartY + (ev.clientY - startY) / scale;
                app.canvas.setDirty(true, true);
            }
            function onUp() {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                node._stickyDragCleanup = null;
                app.canvas.node_dragged = null;
            }
            node._stickyDragCleanup = onUp;
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });

        domEl.addEventListener("dblclick", (e) => {
            e.stopPropagation();
            if (node._stickyDragCleanup) { node._stickyDragCleanup(); node._stickyDragCleanup = null; }
            currentNode = node;
            loadFromNode(node);
            showEditor();
        });

        const origDblClick = node.onDblClick;
        node.onDblClick = function(e, pos, graphcanvas) {
            if (origDblClick) origDblClick.apply(this, arguments);
            currentNode = this;
            loadFromNode(this);
            showEditor();
            return true;
        };

        const origGetExtraMenuOptions = node.getExtraMenuOptions;
        node.getExtraMenuOptions = function(_, options) {
            if (origGetExtraMenuOptions) origGetExtraMenuOptions.apply(this, arguments);
            options.unshift({
                content: "📝 编辑便签",
                callback: () => { currentNode = node; loadFromNode(node); showEditor(); }
            });
        };

        const origRemoved = node.onRemoved;
        node.onRemoved = function() {
            if (currentNode === this) { hideEditor(); currentNode = null; }
            if (origRemoved) origRemoved.apply(this, arguments);
        };

        const origResize = node.onResize;
        node.onResize = function(size) {
            if (origResize) origResize.apply(this, arguments);
            if (this.size[0] < HARD_MIN_W) this.size[0] = HARD_MIN_W;
            if (this.size[1] < HARD_MIN_H) this.size[1] = HARD_MIN_H;
            if (this._stickyUpdateDisplay) this._stickyUpdateDisplay();
        };
    },

    // ==================== Legacy Canvas Path (Nodes 1.0) ====================
    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "StickyNote") return;

        try {
            Object.defineProperty(nodeType.prototype, 'title_mode', {
                get: function() { return LiteGraph.NO_TITLE; },
                set: function(v) {},
                configurable: true, enumerable: true
            });
        } catch(e) {}
        nodeType.prototype.drawTitle = function() {};

        const origOnCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            if (origOnCreated) origOnCreated.apply(this, arguments);
            this.properties = this.properties || {};
            const p = this.properties;
            p.text = (p.text === undefined || p.text === null) ? "双击编辑" : p.text;
            p.fontFamily = p.fontFamily || "Microsoft YaHei";
            p.fontSize = (p.fontSize !== undefined && !isNaN(p.fontSize)) ? p.fontSize : 14;
            p.fontColor = p.fontColor || "#e0e0f0";
            p.bg_color = p.bg_color || "#252830";
            p.bgAlpha = (p.bgAlpha !== undefined && !isNaN(p.bgAlpha)) ? p.bgAlpha : 1.0;
            p.letterSpacing = (p.letterSpacing !== undefined && !isNaN(p.letterSpacing)) ? p.letterSpacing : 0;
            p.lineHeight = (p.lineHeight !== undefined && !isNaN(p.lineHeight)) ? p.lineHeight : 1.4;
            p.textAlign = p.textAlign || "left";
            if (p.fullTransparent === true) { p.bg_color = "transparent"; delete p.fullTransparent; }
            const initW = Math.max(240, calcMinNodeWidth(p.fontSize));
            this.size[0] = Math.max(this.size[0] || initW, initW);
            this.size[1] = Math.max(this.size[1] || 140, HARD_MIN_H);
            this.flags = this.flags || {};
            this.flags.allow_resize = true;
            this.flags.allow_drag = true;
            this.resizable = true;
            this.title = "";
            try { this.collapsable = false; } catch(e) {}
            this.bgcolor = "transparent"; this.color = "transparent";
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function(info) {
            if (origConfigure) origConfigure.apply(this, arguments);
            this.title = "";
            if (this.properties) {
                const p = this.properties;
                if (p.text === undefined || p.text === null) p.text = "双击编辑";
                if (!p.fontFamily) p.fontFamily = "Microsoft YaHei";
                if (p.fontSize === undefined || isNaN(p.fontSize)) p.fontSize = 14;
                if (!p.fontColor) p.fontColor = "#e0e0f0";
                if (!p.bg_color) p.bg_color = "#252830";
                if (p.bgAlpha === undefined || isNaN(p.bgAlpha)) p.bgAlpha = 1.0;
                if (p.letterSpacing === undefined || isNaN(p.letterSpacing)) p.letterSpacing = 0;
                if (p.lineHeight === undefined || isNaN(p.lineHeight)) p.lineHeight = 1.4;
                if (!p.textAlign) p.textAlign = "left";
                const minW = calcMinNodeWidth(p.fontSize);
                if (this.size[0] < minW) this.size[0] = minW;
            }
        };

        const origDblClick = nodeType.prototype.onDblClick;
        nodeType.prototype.onDblClick = function(e, pos, graphcanvas) {
            if (origDblClick) origDblClick.apply(this, arguments);
            currentNode = this; loadFromNode(this); showEditor(); return true;
        };

        const origMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function(e, local_pos, graphcanvas) {
            if (e.button === 0) graphcanvas.node_dragged = this;
            if (origMouseDown) return origMouseDown.apply(this, arguments);
            return false;
        };

        const origRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function() {
            if (currentNode === this) { hideEditor(); currentNode = null; }
            if (origRemoved) origRemoved.apply(this, arguments);
        };

        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function(ctx) {
            this.bgcolor = "transparent"; this.color = "transparent";
            if (origDraw) origDraw.apply(this, arguments);
            const props = this.properties || {};
            const fontSize = (props.fontSize !== undefined && !isNaN(props.fontSize)) ? props.fontSize : 14;
            const fontFamily = props.fontFamily || "Microsoft YaHei";
            const fontColor = props.fontColor || "#e0e0f0";
            const bgColor = props.bg_color || "#252830";
            const bgAlpha = (props.bgAlpha !== undefined && !isNaN(props.bgAlpha)) ? props.bgAlpha : 1.0;
            const letterSpacing = (props.letterSpacing !== undefined && !isNaN(props.letterSpacing)) ? props.letterSpacing : 0;
            const lineHeightMult = (props.lineHeight !== undefined && !isNaN(props.lineHeight)) ? props.lineHeight : 1.4;
            const textAlign = props.textAlign || "left";
            const w = Math.max(this.size ? this.size[0] : 240,140);
            const h = Math.max(this.size ? this.size[1] : 140,60);
            const pad = 10;

            ctx.save();
            if (bgColor !== "transparent") {
                const r = parseInt(bgColor.slice(1,3), 16) || 37;
                const g = parseInt(bgColor.slice(3,5), 16) || 40;
                const b = parseInt(bgColor.slice(5,7), 16) || 48;
                roundRectPath(ctx, 0, 0, w, h, 8);
                ctx.fillStyle = "rgba(" + r + "," + g + "," + b + "," + bgAlpha + ")";
                ctx.fill();
                const grad = ctx.createLinearGradient(0, 0, 0, Math.max(h * 0.45, 1));
                grad.addColorStop(0, "rgba(94,158,252,0.06)");
                grad.addColorStop(1, "rgba(94,158,252,0)");
                roundRectPath(ctx, 0, 0, w, h, 8);
                ctx.fillStyle = grad;
                ctx.fill();
                roundRectPath(ctx, 0.5, 0.5, Math.max(w - 1, 1), Math.max(h - 1, 1), 8);
                ctx.strokeStyle = "rgba(255,255,255,0.05)";
                ctx.lineWidth = 1;
                ctx.stroke();
                roundRectPath(ctx, 0, 0, w, h, 8);
                ctx.strokeStyle = "rgba(94,158,252,0.12)";
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            ctx.beginPath();
            roundRectPath(ctx, 1, 1, Math.max(w - 2, 1), Math.max(h - 2, 1), 7);
            ctx.clip();
            const baseStyle = {
                fontFamily: fontFamily,
                fontSize: fontSize,
                color: fontColor,
                bold: false,
                italic: false,
                underline: false,
                strike: false
            };
            ctx.globalAlpha = 1.0;
            ctx.textBaseline = "top";
            const lineH = Math.max(fontSize * lineHeightMult, 1);
            const textContent = (props.text === undefined || props.text === null) ? "双击编辑" : stripInlineFontSizes(props.text);
            renderHtmlToCanvas(ctx, textContent, pad, pad, Math.max(w - pad * 2, 10), lineH, baseStyle, letterSpacing, textAlign);
            ctx.restore();
        };
    }
});