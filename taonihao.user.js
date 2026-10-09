// ==UserScript==
// @name         TaoNihao — Taobao и Tmall по-русски
// @name:ru      TaoNihao — Taobao и Tmall по-русски
// @name:en      TaoNihao — Taobao & Tmall in Russian
// @namespace    https://tampermonkey.net/
// @license      MIT
// @version      2.13.0
// @description  Taobao и Tmall как родной магазин — на компьютере и в телефоне: цены в рублях по честному P2P-курсу юаня, перевод страниц и отзывов, поиск на русском с сохранением брендов и моделей, перевод надписей на фото прямо в браузере, вес товара рядом с ценой.
// @description:ru  Taobao и Tmall как родной магазин — на компьютере и в телефоне: цены в рублях по честному P2P-курсу юаня, перевод страниц и отзывов, поиск на русском с сохранением брендов и моделей, перевод надписей на фото прямо в браузере, вес товара рядом с ценой.
// @description:en  Shop Taobao & Tmall in Russian on desktop and mobile: prices in rubles at the real P2P yuan rate, page and review translation, Russian search that keeps brands and models, on-image text translation right in the browser.
// @match        *://*.taobao.com/*
// @match        *://*.tmall.com/*
// @run-at       document-start
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      translate.googleapis.com
// @connect      api.rapira.net
// @connect      p2p.binance.com
// @connect      www.okx.com
// @connect      hq.sinajs.cn
// @connect      vision.googleapis.com
// @connect      alicdn.com
// @connect      tbcdn.cn
// @connect      taobaocdn.com
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      unpkg.com
// @downloadURL https://update.greasyfork.org/scripts/599269/TaoNihao%20%E2%80%94%20Taobao%20%D0%B8%20Tmall%20%D0%BF%D0%BE-%D1%80%D1%83%D1%81%D1%81%D0%BA%D0%B8.user.js
// @updateURL https://update.greasyfork.org/scripts/599269/TaoNihao%20%E2%80%94%20Taobao%20%D0%B8%20Tmall%20%D0%BF%D0%BE-%D1%80%D1%83%D1%81%D1%81%D0%BA%D0%B8.meta.js
// ==/UserScript==
 
(function () {
  'use strict';
 
  /* ══════════════════════════════════════════════════════════════════════
   *  0. ЧИСТЫЕ ФУНКЦИИ (без DOM): запросы, цены, курсы, батчи перевода
   * ══════════════════════════════════════════════════════════════════════ */
  // <pure>
  const DEFAULT_RATE = 12.25;      // ручной курс ₽ за 1 ¥
  const DEFAULT_USDT_CNY = 7.15;   // запасное значение ¥ за 1 USDT, пока автоисточники недоступны
 
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
  const LETTER_RE = /\p{L}/u;
 
  // ── поисковый запрос ────────────────────────────────────────────────
  const STOP_WORDS = new Set([
    'и', 'с', 'со', 'в', 'во', 'на', 'для', 'из', 'по', 'от', 'к', 'у', 'а', 'о', 'об',
    'the', 'a', 'an', 'and', 'for', 'with', 'of', 'to', 'in', 'on', 'or', '+', '&'
  ]);
  const KEEP_LATIN = new Set([
    'rtx', 'gtx', 'rx', 'ryzen', 'xeon', 'ddr', 'nvme', 'hdmi', 'usb', 'rgb', 'led',
    'oled', 'amoled', 'ips', 'cpu', 'gpu', 'wifi', 'wi-fi', 'nfc', 'gps', 'lte', 'esim',
    'pro', 'max', 'plus', 'ultra'
  ]);
  const UNITS = {
    'ггц': 'GHz', 'мгц': 'MHz', 'гб': 'GB', 'тб': 'TB', 'мб': 'MB', 'гц': 'Hz',
    'мач': 'mAh', 'вт': 'W', 'мм': 'mm', 'см': 'cm', 'кг': 'kg', 'мп': 'MP'
  };
  // составные слова, где 的/和/与/带/有 — часть слова, а не союз
  const KEEP_COMPOUNDS = [
    '传送带', '安全带', '松紧带', '魔术带', '没有', '皮带', '领带', '背带', '磁带', '腰带', '胶带',
    '绷带', '丝带', '鞋带', '吊带', '肩带', '束带', '表带', '腕带', '头带', '发带', '织带',
    '绑带', '带子', '带扣', '带轮', '灯带', '所有', '拥有', '具有', '现有', '有机', '有线', '有限',
    '有源', '有声', '有色', '有氧', '有效', '有用', '和田', '和服', '和平', '柔和', '温和',
    '暖和', '缓和', '目的', '的确', '的士'
  ].sort((a, b) => b.length - a.length);
 
  function normalizeQuery(raw) {
    let s = String(raw).replace(/[\u00a0\u3000]/g, ' ');
    s = s.replace(/[,;，、；|()（）\[\]{}«»"“”]/g, ' ');
    s = s.replace(
      /(\d+(?:[.,]\d+)?)\s*(ггц|мгц|гб|тб|мб|гц|мач|вт|мм|см|кг|мп)(?![\p{L}])/giu,
      (_, n, u) => n.replace(',', '.') + UNITS[u.toLowerCase()]
    );
    s = s.replace(/(\d+)[кК](?![\p{L}\d])/gu, '$1K');
    return s.replace(/\s+/g, ' ').trim();
  }
 
  /** Токен нельзя переводить: модель, число, стандарт, аббревиатура, иероглифы. */
  function isProtected(tok) {
    if (CJK_RE.test(tok)) return true;
    if (!LETTER_RE.test(tok)) return true;
    if (KEEP_LATIN.has(tok.toLowerCase())) return true;
    if (/^[\x21-\x7e]+$/.test(tok)) {
      if (/\d/.test(tok)) return true;                                   // RTX5050, i7-13645HX, 180Hz, 4K
      if (/[-_/]/.test(tok.replace(/^[-_/]+|[-_/]+$/g, ''))) return true; // Type-C, Wi-Fi
      if (/^[A-Z]{2,}$/.test(tok)) return true;                          // LED, USB
      if (/^[a-z]+[A-Z]/.test(tok)) return true;                         // iPhone
    }
    return false;
  }
 
  /** Запрос → сегменты: keep (как есть) и пробеги слов для перевода (контекст внутри сохраняется). */
  function buildPlan(raw) {
    const norm = normalizeQuery(raw);
    const parts = [];
    for (const t of norm.split(' ')) {
      const tok = t.replace(/^[.:!?\-–—_/\\]+|[.:!?\-–—_/\\]+$/g, '');
      if (!tok || STOP_WORDS.has(tok.toLowerCase())) continue;
      if (isProtected(tok)) parts.push({ keep: true, text: tok });
      else {
        const last = parts[parts.length - 1];
        if (last && !last.keep) last.text += ' ' + tok;
        else parts.push({ keep: false, text: tok });
      }
    }
    return { norm, parts, runs: parts.filter((p) => !p.keep).length };
  }
 
  /** Китайский перевод → чистые теги: убрать 的/和/与/带/有/+ и пунктуацию. */
  function cleanZh(input) {
    let s = String(input);
    const masked = [];
    for (const w of KEEP_COMPOUNDS) {
      if (s.includes(w)) { s = s.split(w).join('\uE000' + masked.length + '\uE001'); masked.push(w); }
    }
    s = s.replace(/[的和与带有+＋&]/g, ' ');
    s = s.replace(/[，。、；：！？“”‘’《》「」『』（）()\[\]【】,;:!?"]/g, ' ');
    s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
    s = s.replace(/\uE000(\d+)\uE001/g, (_, i) => masked[+i]);
    return s.replace(/\s+/g, ' ').trim();
  }
 
  // ── цены ────────────────────────────────────────────────────────────
  // Цена целиком в одном узле: «¥158», «¥0.3», «约省¥0.68», «券后¥79.9», «¥79-¥120», «¥99起», «¥5.9/件»
  const PRICE_RE = /^([^\d¥￥]{0,80}?)\s*[¥￥]\s*(\d[\d,]*(?:\.\d+)?)(?:\s*[-~–—至]\s*[¥￥]?\s*(\d[\d,]*(?:\.\d+)?))?\s*(?:起售|起|\+|\/\s*[\p{L}.]{1,8})?\s*$/u;
  const NOSYM_RE = /^(\d[\d,]*(?:\.\d+)?)$/;
  // Числовая часть после отдельного символа ¥: «18.96», «4», «79-¥120»
  const NUM_PART_RE = /^(\d[\d,]*(?:\.\d+)?)(?:[-~–—至][¥￥]?(\d[\d,]*(?:\.\d+)?))?$/;
 
  const num = (s) => parseFloat(String(s).replace(/,/g, ''));
 
  function parsePrice(text, requireSym) {
    let m = PRICE_RE.exec(text);
    if (m) {
      const lo = num(m[2]);
      const hi = m[3] !== undefined ? num(m[3]) : null;
      if (isFinite(lo) && (hi === null || isFinite(hi)) && !(lo === 0 && hi === null)) {
        return { prefix: (m[1] || '').trim(), lo, hi };
      }
      return null;
    }
    if (requireSym) return null;
    m = NOSYM_RE.exec(text);
    if (m && num(m[1]) > 0) return { prefix: '', lo: num(m[1]), hi: null };
    return null;
  }
 
  /** Фрагмент текста соседнего узла может быть частью числа («18», «.96», «-», «¥»). */
  function isNumFrag(t) { return /^[\d.,\-~–—至¥￥]+$/.test(t); }
 
  /** Не склеиваем два отдельных числа («5» + «100» из соседнего блока продаж). */
  function canAppendFrag(acc, frag) {
    if (!acc) return /^\d/.test(frag);
    return !(/\d$/.test(acc) && /^\d/.test(frag));
  }
 
  function parseNumPart(s) {
    const m = NUM_PART_RE.exec(s);
    if (!m) return null;
    const lo = num(m[1]);
    const hi = m[2] !== undefined ? num(m[2]) : null;
    if (!isFinite(lo) || (hi !== null && !isFinite(hi)) || (lo === 0 && hi === null)) return null;
    return { prefix: '', lo, hi };
  }
 
  // Подписи перед ценой внутри того же узла («约省¥3», «券后¥79»): в режиме «Замена» показываем по-русски
  const PREFIX_RU = { '约省': 'экономия ≈', '省': 'экономия', '共省': 'экономия', '已省': 'экономия', '立省': 'экономия',
    '券后': 'с купоном', '到手价': 'итого', '到手': 'итого', '低至': 'от', '约': '≈', '直降': 'скидка', '优惠': 'скидка',
    '补贴': 'субсидия', '已补': 'субсидия', '原价': 'было', '折后': 'со скидкой', '预估到手': '≈ итого', '首单价': 'первый заказ' };
  function ruPrefix(p) {
    const t = String(p || '').replace(/[:：]\s*$/, '').trim();
    if (!t) return '';
    if (!CJK_RE.test(t)) return t;
    if (Object.prototype.hasOwnProperty.call(PREFIX_RU, t)) return PREFIX_RU[t];
    const l = typeof localTranslate === 'function' ? localTranslate(t) : null;
    return l !== null ? l : '';
  }

  function formatRub(cny, rate) {
    const v = cny * rate;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: v < 100 ? 1 : 0 }).format(v);
  }
 
  function sanitizeRate(x) {
    const n = parseFloat(String(x).replace(',', '.'));
    return isFinite(n) && n > 0 && n < 10000 ? Math.round(n * 10000) / 10000 : null;
  }
 
  // ── курсы ───────────────────────────────────────────────────────────
  function computeRate(auto, usdtRub, usdtCny, manual) {
    if (auto && usdtRub > 0 && usdtCny > 0) return Math.round((usdtRub / usdtCny) * 10000) / 10000;
    return manual;
  }
 
  function parseRapira(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
    const it = list.find((x) => x && x.symbol === 'USDT/RUB');
    if (!it) return null;
    const v = parseFloat(it.close !== undefined ? it.close : (it.last !== undefined ? it.last : it.lastPrice));
    return isFinite(v) && v > 20 && v < 1000 ? v : null;
  }
 
  const CNY_MIN = 5.5, CNY_MAX = 9;
  const okCny = (v) => isFinite(v) && v >= CNY_MIN && v <= CNY_MAX;
  const round4 = (v) => Math.round(v * 10000) / 10000;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
 
  function median(a) {
    const s = a.slice().sort((x, y) => x - y), n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
 
  function parseBinanceP2P(json) {
    const list = json && Array.isArray(json.data) ? json.data : [];
    return median(list.slice(0, 10).map((x) => parseFloat(x && x.adv && x.adv.price)).filter(okCny));
  }
 
  function parseOkxP2P(json) {
    const d = json && json.data;
    if (!d) return null;
    const side = (arr) => median((Array.isArray(arr) ? arr : []).slice(0, 10).map((x) => parseFloat(x && x.price)).filter(okCny));
    const m = [side(d.sell), side(d.buy)].filter((v) => v !== null);
    return m.length ? mean(m) : null;
  }
 
  function parseOkxFx(json) {
    const v = parseFloat(json && json.data && json.data[0] && json.data[0].usdCny);
    return okCny(v) ? v : null;
  }
 
  function parseSinaFx(text) {
    const m = /="([^"]*)"/.exec(String(text));
    if (!m) return null;
    const f = m[1].split(',');
    const v = [1, 2].map((i) => parseFloat(f[i])).filter(okCny);
    return v.length ? mean(v) : null;
  }
 
  /** Приоритет: P2P (реальный рынок USDT→CNY), затем форекс USD/CNY. */
  function pickUsdtCny(r) {
    const has = (x) => x[1] !== null && x[1] !== undefined;
    const p2p = [['Binance', r.binance], ['OKX', r.okxP2p]].filter(has);
    if (p2p.length) return { value: round4(mean(p2p.map((x) => x[1]))), kind: 'P2P', parts: p2p };
    const fx = [['OKX', r.okxFx], ['Sina', r.sina]].filter(has);
    if (fx.length) return { value: round4(mean(fx.map((x) => x[1]))), kind: 'FX', parts: fx };
    return null;
  }
 
 
  // ── словарь интерфейса Taobao/Tmall (машинный перевод тут ошибается: 宝贝 = «товар», а не «малыш») ──
  // Можно дополнять своими строками: 'китайский текст': 'перевод'.
  const UI_DICT = {
    // надписи на фото, которые Google переводит неверно (款 — «модель», а не «деньги»)
    '无边款': 'Безрамочная модель', '无边款式': 'Безрамочная модель', '无边框': 'Без рамки',
    // шапка, меню пользователя
    '淘宝网首页': 'Главная Taobao', '淘宝首页': 'Главная Taobao', '我的淘宝': 'Мой Taobao', '已买到的宝贝': 'Покупки',
    '已买到': 'Мои покупки', '我的足迹': 'История просмотров', '足迹': 'История просмотров', '我的卡券包': 'Мои купоны',
    '收藏的宝贝': 'Избранные товары', '收藏的店铺': 'Избранные магазины', '已卖出的宝贝': 'Проданные товары',
    '出售中的宝贝': 'Товары в продаже', '收藏夹': 'Избранное', '购物车': 'Корзина', '帮助中心': 'Справка',
    '意见反馈': 'Обратная связь', '反馈': 'Отзыв о сайте', '账号管理': 'Управление аккаунтом', '退出': 'Выйти',
    '查看你的专属权益': 'Ваши привилегии', '网页无障碍': 'Доступность', '切换企业版': 'Для бизнеса', '切换': '', '企业版': 'Для бизнеса', '中文(zh)': 'Китайский (zh)', '英文(en)': 'Английский (en)',
    '中国大陆': 'Материковый Китай', '免费开店': 'Открыть магазин', '淘宝开店': 'Магазин на Taobao', '天猫开店': 'Магазин на Tmall',
    '开直播店': 'Стрим-магазин', '千牛卖家中心': 'Qianniu', '商家中心': 'Центр продавца', '开店入驻': 'Стать продавцом',
    '卖家服务市场': 'Сервисы для продавцов', '卖家培训中心': 'Обучение продавцов', '体检中心': 'Проверка магазина',
    '电商学习中心': 'Обучение e-commerce', '商家客服': 'Поддержка продавцов', '消息中心': 'Сообщения', '举报中心': 'Жалобы',
    '淘宝规则': 'Правила Taobao', '天猫规则': 'Правила Tmall', '规则众议': 'Обсуждение правил', '商家支持': 'Поддержка продавцов',
    '商家入驻': 'Стать продавцом', '淘天标准': 'Стандарты Taobao/Tmall', '商家工具': 'Инструменты продавца',
    '商家学习中心': 'Обучение продавцов', '商家服务大厅': 'Сервисы для продавцов', '问商友': 'Спросить продавцов',
    '消费者客服': 'Поддержка покупателей', '卖家客服': 'Поддержка продавцов', '网页版旺旺': 'Чат Wangwang', '桌面版': 'Версия для ПК',
    '回顶部': 'Наверх', '全部频道': 'Все разделы', '分类': 'Категории', '天猫超市': 'Tmall Супермаркет', '天猫国际': 'Tmall International',
    '聚划算': 'Групповые скидки', '直播频道': 'Прямые эфиры', '飞猪旅行': 'Путешествия Fliggy', '淘宝客户端': 'Приложение Taobao',
    // поиск и фильтры
    '搜索': 'Найти', '搜本店': 'В магазине', '宝贝': 'Товары', '店铺': 'Магазины', '天猫': 'Tmall', '淘宝': 'Taobao',
    '按图片搜索': 'Поиск по фото', '上传图片': 'Загрузить фото', 'Ctrl+V 粘贴图片到此处': 'Ctrl+V — вставьте картинку сюда',
    'Ctrl+V 粘贴图片快速图搜': 'Ctrl+V — быстрый поиск по картинке', '搜同款': 'Найти такой же', '所有宝贝': 'Все товары',
    '企业购': 'Для бизнеса', '发货地': 'Откуда отправка', '综合': 'По релевантности', '销量': 'По продажам', '价格': 'Цена',
    '区间': 'Диапазон', '¥最低价': '¥ от', '¥最高价': '¥ до', '最低价': 'от', '最高价': 'до', '包邮': 'Бесплатная доставка', '退货宝': 'Страховка возврата', '淘金币抵钱': 'Оплата монетами Taobao',
    '筛选': 'Фильтры', '上一页': 'Назад', '下一页': 'Вперёд', '到第': 'Перейти на', '页': 'стр.', '确定': 'OK',
    '大家都在搜': 'Часто ищут',
    // метки в карточках
    '首单价': 'Цена 1-го заказа', '优惠后': 'После скидки', '券后': 'С купоном', '大促价保': 'Гарантия цены',
    '降价提醒': 'Сообщить о снижении цены', '不喜欢该商品': 'Не нравится товар', '您加购的商品降价了': 'Товар из корзины подешевел',
    '失效': 'Недействительно', '热销爆款': 'Хит продаж', '官方客服': 'Официальная поддержка', '品牌入口': 'Бренды',
    '天猫榜单': 'Рейтинги Tmall', '热卖频道': 'Хиты продаж', '超级88': 'Super 88', '国家补贴': 'Госсубсидия',
    '百亿补贴 · 买贵必赔': 'Субсидии · вернём разницу', '淘宝秒杀': 'Флеш-скидки', '领券中心': 'Купоны',
    '大牌试用': 'Пробники брендов', '猜你喜欢': 'Вам может понравиться', '更多低价商品': 'Ещё недорогие товары', '刷新': 'Обновить',
    '关注店铺': 'Подписаться на магазин', '热销推荐': 'Хиты продаж', '好评推荐': 'С лучшими отзывами', '近期热卖': 'Сейчас популярно',
    // блок пользователя на главной
    '登录淘宝后更多精彩': 'Войдите в Taobao, чтобы увидеть больше', '立即登录': 'Войти', '收货地址': 'Адреса доставки',
    '待付款': 'Ожидают оплаты', '待发货': 'Ожидают отправки', '待收货': 'В пути', '待评价': 'Ждут отзыва', '红包': 'Бонусы',
    '优惠券': 'Купоны', '张': 'шт.', '猜你想搜': 'Вам может быть интересно', '换一换': 'Обновить', '历史搜索': 'История поиска', '清空': 'Очистить', '热搜': 'Популярное', '结算': 'Оформить', '领券结算': 'К оплате', '移入收藏': 'В избранное', '搜淘宝': 'Найти', '平台加补后': 'С субсидией', '店铺优惠后': 'Со скидкой', '含礼金共减': 'Всего скидка', '共减': 'Скидка', '优惠明细': 'Детали скидки', '取消选择': 'Снять выбор', '商品总价': 'Сумма товаров', '店铺优惠': 'Скидка магазина', '平台优惠': 'Скидка платформы', '小计': 'Итого', '合计': 'Итого', '合计:': 'Итого:', '合计：': 'Итого:', '全选': 'Выбрать все', '删除': 'Удалить', '失效宝贝': 'Недоступные товары', '清空失效宝贝': 'Очистить недоступные', '重新选择规格': 'Выбрать вариант', '款式缺货': 'Нет в наличии', '降价': 'Подешевело', '起': 'и выше', '图集': 'Фото сеткой', '用户评价': 'Отзывы', '查看全部评价': 'Все отзывы', '追评': 'Дополнения к отзывам', '淘金币抵': 'Монеты Taobao', '买过的店': 'Мои магазины', '消息': 'Сообщения', '逛一逛': 'Обзор',
    // карточка товара
    '客服': 'Поддержка', '进店': 'В магазин', '视频': 'Видео', '图集': 'Фото', '参数': 'Характеристики', '用户评价': 'Отзывы',
    '参数信息': 'Характеристики', '图文详情': 'Описание', '本店推荐': 'Рекомендации магазина', '看了又看': 'С этим смотрят',
    '查看全部评价': 'Все отзывы', '匿名买家': 'Анонимный покупатель', '颜色分类': 'Вариант', '发光颜色': 'Цвет свечения',
    '尺码': 'Размер', '尺寸': 'Размер', '套餐类型': 'Комплектация', '平台加补后': 'С субсидией платформы', '优惠前': 'До скидки',
    '已享受:': 'Применено:', '可再享:': 'Ещё доступно:', '即时可用': 'Действует сразу',
    '首单礼金店铺新客专享': 'Бонус на первый заказ для новых покупателей', '可开发票': 'Можно выставить счёт',
    '假一赔四': 'Подделка — компенсация ×4', '极速退款': 'Быстрый возврат денег', '7天无理由退换': 'Возврат 7 дней без причины',
    '信用卡支付': 'Оплата кредитной картой', '切换大图模式': 'Крупные изображения', '数量': 'Количество', '有货': 'В наличии',
    '无货': 'Нет в наличии', '领券购买': 'Купить с купоном', '立即购买': 'Купить сейчас', '加入购物车': 'В корзину', '收藏': 'В избранное',
    '用户调研': 'Опрос', '商品码': 'Код товара', '扫一扫 在手机淘宝查看': 'Откройте в приложении Taobao', '更多': 'Ещё',
    '复制链接': 'Копировать ссылку', '举报': 'Пожаловаться', '问问': 'Спросить', '有什么想了解的，问我吧': 'Есть вопросы? Спросите меня',
    '联系客服': 'Написать продавцу', '旺旺在线': 'Продавец онлайн', '材质': 'Материал', '色温': 'Цветовая температура',
    '控制方式': 'Способ управления', '电压': 'Напряжение', '款式': 'Модель', '品牌': 'Бренд', '型号': 'Артикул',
    '控制类型': 'Тип управления', '计价单位': 'Единица', '蓝光危害等级': 'Класс опасности синего света', '安装方式': 'Монтаж',
    '明装': 'Накладной монтаж', '暖黄': 'Тёплый жёлтый', '中性光': 'Нейтральный свет', '暖光': 'Тёплый свет', '白光': 'Холодный белый',
    '已连接天猫精灵': 'Работает с Tmall Genie', '产地': 'Страна производства', '适用空间': 'Помещение', '功率': 'Мощность',
    '颜色': 'Цвет', '重量': 'Вес', '长度': 'Длина', '宽度': 'Ширина', '高度': 'Высота'
  };
 
  // Типовые фразы инфографики на фото товара (машинный перевод без контекста ошибается: 外弯 → «развал», 贴心 → «интимный»)
  Object.assign(UI_DICT, {
    '质量保证': 'Гарантия качества', '品质保证': 'Гарантия качества', '厂家直供': 'Напрямую с завода', '工厂直供': 'Напрямую с завода',
    '源头厂家': 'Производитель', '实力厂家': 'Производитель', '厂家直销': 'Напрямую от производителя', '价格实惠': 'Выгодная цена',
    '性价比高': 'Выгодная цена', '贴心售后': 'Заботливый сервис', '售后无忧': 'Сервис без забот', '无忧售后': 'Сервис без забот',
    '损坏包赔': 'Замена при повреждении', '破损包赔': 'Замена при повреждении', '极速发货': 'Быстрая отправка', '闪电发货': 'Быстрая отправка',
    '质保三年': 'Гарантия 3 года', '三年质保': 'Гарантия 3 года', '质保两年': 'Гарантия 2 года', '两年质保': 'Гарантия 2 года',
    '质保一年': 'Гарантия 1 год', '一年质保': 'Гарантия 1 год', '以换代修': 'Замена вместо ремонта', '为什么选择我们': 'Почему мы?',
    '为什么选择我们?': 'Почему мы?', '为什么选择我们？': 'Почему мы?', '购买须知': 'Перед покупкой', '温馨提示': 'Обратите внимание',
    '产品参数': 'Характеристики', '产品详情': 'Описание товара', '安装示意图': 'Схема монтажа', '安装方法': 'Способ монтажа',
    '内弯效果': 'Изгиб внутрь', '外弯效果': 'Изгиб наружу', '效果图': 'Пример', '实拍图': 'Реальное фото', '细节展示': 'Детали',
    '长寿命': 'Долгий срок службы', '高光效': 'Высокая светоотдача', '色彩丰富': 'Насыщенные цвета', '低消耗': 'Низкое потребление',
    '低功耗': 'Низкое потребление', '低光衰': 'Медленная деградация', '无频闪': 'Без мерцания', '不伤眼': 'Безопасно для глаз',
    '防水': 'Водостойкий', '耐高温': 'Термостойкий', '可定制': 'Под заказ', '支持定制': 'Под заказ', '量大从优': 'Скидки на опт',
    '现货速发': 'В наличии, быстрая отправка', '包邮': 'Бесплатная доставка', '正品保障': 'Гарантия оригинала'
  });

  // Типовые строки с числами: «1000+人付款», «满11减8», «8年老店» …
  function cnNum(s) {
    return String(s).replace(/([\d.]+)([万千])/g, (_, n, u) =>
      Math.round(parseFloat(n) * (u === '万' ? 10000 : 1000)).toLocaleString('ru-RU'));
  }
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  }
  const N = '([\\d.]+[万千]?\\+?)';
  const UI_PATTERNS = [
    [new RegExp('^' + N + '人付款$'), (m) => cnNum(m[1]) + ' оплатили'],
    [new RegExp('^' + N + '人(?:购买|已买)$'), (m) => cnNum(m[1]) + ' купили'],
    [new RegExp('^' + N + '人已抢$'), (m) => cnNum(m[1]) + ' уже купили'],
    [new RegExp('^' + N + '人(?:收藏|想要)$'), (m) => cnNum(m[1]) + ' в избранном'],
    [new RegExp('^超' + N + '人加购$'), (m) => 'Более ' + cnNum(m[1]) + ' добавили в корзину'],
    [new RegExp('^已售\\s*' + N + '$'), (m) => 'Продано ' + cnNum(m[1])],
    [new RegExp('^月销\\s*' + N + '$'), (m) => 'Продано за месяц ' + cnNum(m[1])],
    [/^(\d+)年老店$/, (m) => 'Магазину ' + m[1] + ' ' + plural(+m[1], 'год', 'года', 'лет')],
    [/^直降([\d.]+)元$/, (m) => 'Скидка ¥' + m[1]],
    [/^已降([\d.]+)元$/, (m) => 'Подешевел на ¥' + m[1]],
    [/^已补([\d.]+)元$/, (m) => 'Субсидия ¥' + m[1]],
    [/^官方立减([\d.]+)%省([\d.]+)元$/, (m) => 'Скидка платформы ' + m[1] + '% (−' + m[2] + ' ¥)'],
    [/^官方立减([\d.]+)%$/, (m) => 'Скидка платформы ' + m[1] + '%'],
    [/^官方立减([\d.]+)元$/, (m) => 'Скидка платформы ¥' + m[1]],
    [/^超级立减([\d.]+)%$/, (m) => 'Суперскидка ' + m[1] + '%'],
    [/^超级立减([\d.]+)元$/, (m) => 'Суперскидка ¥' + m[1]],
    [/^券满([\d.]+)减([\d.]+)$/, (m) => 'Купон: −' + m[2] + ' ¥ от ' + m[1] + ' ¥'],
    [/^满([\d.]+)减([\d.]+)$/, (m) => '−' + m[2] + ' ¥ от ' + m[1] + ' ¥'],
    [/^满([\d.]+)元?打([\d.]+)折$/, (m) => 'Скидка ' + Math.round(100 - parseFloat(m[2]) * 10) + '% от ' + m[1] + ' ¥'],
    [/^淘金币(?:可)?抵([\d.]+)元起?$/, (m) => 'Монетами Taobao −¥' + m[1]],
    [/^政府补贴([\d.]+%)$/, (m) => 'Госсубсидия ' + m[1]],
    [/^店铺新客减([\d.]+)元$/, (m) => 'Новым покупателям −¥' + m[1]],
    [/^(\d+)小时内发(?:货)?$/, (m) => 'Отправка в течение ' + m[1] + ' ч'],
    [/^(\d+)天内发(?:货)?$/, (m) => 'Отправка в течение ' + m[1] + ' ' + plural(+m[1], 'дня', 'дней', 'дней')],
    [/^回头客(\d+)人$/, (m) => 'Постоянных покупателей: ' + m[1]],
    [/^(\d+)天新增(\d+)条好评$/, (m) => '+' + m[2] + ' хороших отзывов за ' + m[1] + ' дн.'],
    [/^及时发货率([\d.]+%)$/, (m) => 'Своевременная отправка: ' + m[1]],
    [/^客服平均(\d+)秒回复$/, (m) => 'Поддержка отвечает в среднем за ' + m[1] + ' с'],
    [/^(\d+)元红包仅剩\s*(\d+)小时$/, (m) => 'Бонус ' + m[1] + ' ¥ · осталось ' + m[2] + ' ч'],
    [/^([\d.]+)折起$/, (m) => 'Скидки до ' + Math.round(100 - parseFloat(m[1]) * 10) + '%']
  ];
 
  /** Перевод без Google: словарь интерфейса и шаблоны. null — отдать машинному переводу. */
  function localTranslate(core) {
    if (Object.prototype.hasOwnProperty.call(UI_DICT, core)) return UI_DICT[core];
    for (const [re, fn] of UI_PATTERNS) { const m = re.exec(core); if (m) return fn(m); }
    return null;
  }
 
  // Сленг Taobao, который сбивает машинный перевод: заменяем на нейтральные слова перед отправкой в Google
  const SLANG = [['宝贝', '商品'], ['亲们', '顾客们'], ['亲', '您'], ['掌柜', '店主'], ['旺旺', '客服聊天'], ['淘金币', '淘宝金币'],
    ['包邮', '免运费'], ['拍下', '下单'], ['秒杀', '限时抢购']];
  // Типовые огрехи машинного перевода в подписях вариантов (颜色分类：…, 发光颜色：…)
  const RU_FIX = [[/^Классификация цвет(?:ов|а)\s*:?/i, 'Вариант:'], [/^Цветовая классификация\s*:?/i, 'Вариант:'],
    [/^Светящийся цвет\s*:?/i, 'Цвет свечения:'], [/^Цвет свечения\s*:?/i, 'Цвет свечения:']];
  function fixRu(t) { let s = String(t); for (const [re, to] of RU_FIX) s = s.replace(re, to); return s; }

  function prepForGoogle(core) {
    let s = core;
    for (const [a, b] of SLANG) if (s.includes(a)) s = s.split(a).join(b);
    return s;
  }
 
  // ── перевод страницы: батчи для Google ──────────────────────────────
  /** Делит строки на батчи так, чтобы закодированный q не превышал maxEnc символов. */
  function buildBatches(list, maxEnc) {
    const out = [];
    let cur = [], len = 0;
    for (const s of list) {
      const l = encodeURIComponent(s).length + 3;
      if (cur.length && len + l > maxEnc) { out.push(cur); cur = []; len = 0; }
      cur.push(s); len += l;
    }
    if (cur.length) out.push(cur);
    return out;
  }
 
  function parseGtx(data) {
    return ((data && data[0]) || []).map((s) => s && s[0]).filter((x) => typeof x === 'string').join('');
  }
 
  /** Разбирает перевод батча обратно по строкам; null — если Google склеил/потерял строки. */
  function splitGtx(joined, n) {
    const parts = String(joined).split('\n').map((s) => s.trim());
    while (parts.length > n && parts[parts.length - 1] === '') parts.pop();
    return parts.length === n && parts.every(Boolean) ? parts : null;
  }
 
  // ── OCR картинки: разбор ответа Google Cloud Vision и геометрия ─────
  const OCR_MAX_BYTES = 7 * 1024 * 1024;     // лимит запроса Vision 10 МБ, base64 раздувает размер на треть
 
  function sniffMime(u8) {
    if (u8.length > 12) {
      if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
      if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
      if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
      if (u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
    }
    return null;
  }
 
  function bytesToBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
 
  /** Строки абзаца → одна фраза: разрядку «检 测 报 告» склеиваем, настоящие пробелы между словами оставляем, переносы → пробел. */
  function tidyOcrText(t) {
    const single = (x) => x.length === 1 && /[㐀-鿿＀-￯]/.test(x);
    return String(t).split('\n').map((line) => {
      const out = [];
      for (const tok of line.trim().split(/\s+/).filter(Boolean)) {
        const last = out[out.length - 1];
        if (last && last.run && single(tok)) last.s += tok; else out.push({ s: tok, run: single(tok) });
      }
      return out.map((o) => o.s).join(' ');
    }).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }
 
  /** Vision не присылает x/y, равные 0 — подставляем ноль. */
  function vertsOf(box) {
    const v = box && box.vertices;
    if (!Array.isArray(v) || v.length < 4) return null;
    return v.slice(0, 4).map((p) => ({ x: Number(p && p.x) || 0, y: Number(p && p.y) || 0 }));
  }
 
  /** Ответ images:annotate (один элемент responses[]) → [{text, verts}] по абзацам. */
  function visionToBlocks(r) {
    const out = [];
    const pages = r && r.fullTextAnnotation && r.fullTextAnnotation.pages;
    if (pages && pages.length) {
      for (const pg of pages) for (const b of pg.blocks || []) for (const p of b.paragraphs || []) {
        let t = '';
        for (const w of p.words || []) for (const sym of w.symbols || []) {
          t += sym.text || '';
          const br = sym.property && sym.property.detectedBreak && sym.property.detectedBreak.type;
          if (br === 'SPACE' || br === 'SURE_SPACE') t += ' ';
          else if (br === 'EOL_SURE_SPACE' || br === 'LINE_BREAK') t += '\n';
        }
        const verts = vertsOf(p.boundingBox);
        if (verts) out.push({ text: tidyOcrText(t), verts });
      }
    } else {
      // запасной путь: textAnnotations[0] — весь текст, дальше отдельные фрагменты с рамками
      for (const a of ((r && r.textAnnotations) || []).slice(1)) {
        const verts = vertsOf(a.boundingPoly);
        if (verts) out.push({ text: tidyOcrText(a.description || ''), verts });
      }
    }
    return out.filter((b) => b.text);
  }
 
  /** Четырёхугольник текста → центр, размеры вдоль/поперёк строки и угол (градусы). */
  function quadInfo(v) {
    const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    let ang = Math.atan2(v[1].y - v[0].y, v[1].x - v[0].x) * 180 / Math.PI;
    if (Math.abs(ang) < 2 || Math.abs(ang) > 90) ang = 0;
    return {
      cx: (v[0].x + v[1].x + v[2].x + v[3].x) / 4,
      cy: (v[0].y + v[1].y + v[2].y + v[3].y) / 4,
      w: Math.max(d(v[0], v[1]), 1),
      h: Math.max(d(v[1], v[2]), 1),
      ang
    };
  }
 
  function textColorFor(rgb) {
    const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return l > 150 ? '#161616' : '#ffffff';
  }
  // ── Локальный OCR (PaddleOCR): постобработка детектора, CTC-декодер, склейка строк ──
 
  /**
   * Карта вероятностей детектора DBNet (w×h, 0..1) → прямоугольники строк текста.
   * Связные области выше порога, средняя уверенность ≥ boxThr, рамка расширяется (unclip), как в PaddleOCR.
   */
  function detBoxes(prob, w, h, opts) {
    const o = Object.assign({ thr: 0.3, boxThr: 0.5, unclip: 1.6, minSide: 3 }, opts || {});
    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    const out = [];
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || prob[start] <= o.thr) continue;
      let sp = 0, x0 = w, y0 = h, x1 = -1, y1 = -1, sum = 0, cnt = 0;
      stack[sp++] = start; seen[start] = 1;
      while (sp) {
        const i = stack[--sp];
        const x = i % w, y = (i - x) / w;
        sum += prob[i]; cnt++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0) { const j = i - 1; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
        if (x < w - 1) { const j = i + 1; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
        if (y > 0) { const j = i - w; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
        if (y < h - 1) { const j = i + w; if (!seen[j] && prob[j] > o.thr) { seen[j] = 1; stack[sp++] = j; } }
      }
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (Math.min(bw, bh) < o.minSide) continue;
      const score = sum / cnt;
      if (score < o.boxThr) continue;
      const d = (bw * bh * o.unclip) / (2 * (bw + bh));
      out.push({
        x0: Math.max(0, x0 - d), y0: Math.max(0, y0 - d),
        x1: Math.min(w, x1 + 1 + d), y1: Math.min(h, y1 + 1 + d), score
      });
    }
    return out;
  }
 
  /** Выход распознавателя [T×C] (softmax) → текст: argmax, без «пустых» (индекс 0) и повторов. */
  function ctcDecode(data, T, C, chars) {
    let text = '', prev = -1, sc = 0, n = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bv = -Infinity;
      const base = t * C;
      for (let c = 0; c < C; c++) { const v = data[base + c]; if (v > bv) { bv = v; best = c; } }
      if (best !== 0 && best !== prev) { text += chars[best] || ''; sc += bv; n++; }
      prev = best;
    }
    return { text, score: n ? sc / n : 0 };
  }
 
  /** Список символов для распознавателя: blank + словарь (+ пробел, если классов на один больше). */
  function ctcChars(keysText, C) {
    const keys = String(keysText).replace(/\r/g, '').split('\n');
    if (keys.length && keys[keys.length - 1] === '') keys.pop();
    const chars = ['', ...keys];
    if (C === chars.length + 1) chars.push(' ');
    return chars;
  }
 
  /** Длинную картинку (описание товара) режем на перекрывающиеся полосы — мелкий текст не теряется при сжатии. */
  function tilesFor(W, H, maxAspect, overlap) {
    const ma = maxAspect || 1.5, ov = overlap === undefined ? 0.12 : overlap;
    // широкий баннер (7680×120 на главной): режем по ширине, иначе при сжатии до 960 px текст становится в пару пикселей
    const tw = Math.max(960, Math.round(H * 4));
    if (W > tw * 1.15) {
      const step = Math.round(tw * (1 - ov));
      const tiles = [];
      for (let x = 0; ; x += step) {
        const x0 = Math.min(x, Math.max(0, W - tw)), x1 = Math.min(W, x0 + tw);
        tiles.push({ x0, x1, y0: 0, y1: H, k0: 0, k1: H });
        if (x1 >= W) break;
      }
      tiles.forEach((t, i) => {
        t.kx0 = i === 0 ? 0 : Math.round((t.x0 + tiles[i - 1].x1) / 2);
        t.kx1 = i === tiles.length - 1 ? W : Math.round((tiles[i + 1].x0 + t.x1) / 2);
      });
      return tiles;
    }
    const th = Math.round(W * ma);
    if (H <= th * 1.15) return [{ x0: 0, x1: W, y0: 0, y1: H, kx0: 0, kx1: W, k0: 0, k1: H }];
    const step = Math.round(th * (1 - ov));
    const tiles = [];
    for (let y = 0; ; y += step) {
      const y0 = Math.min(y, Math.max(0, H - th)), y1 = Math.min(H, y0 + th);
      tiles.push({ x0: 0, x1: W, y0, y1, kx0: 0, kx1: W });
      if (y1 >= H) break;
    }
    // зона «ответственности» полосы: середина перекрытия с соседями
    tiles.forEach((t, i) => {
      t.k0 = i === 0 ? 0 : Math.round((t.y0 + tiles[i - 1].y1) / 2);
      t.k1 = i === tiles.length - 1 ? H : Math.round((tiles[i + 1].y0 + t.y1) / 2);
    });
    return tiles;
  }
 
  /** Строки → абзацы: соседние по вертикали строки одного кегля и колонки склеиваем (лучше перевод, ровнее плашки). */
  function mergeLines(lines) {
    const ls = lines.map((l) => Object.assign({}, l)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const out = [];
    const cjkEnd = /[㐀-鿿＀-￯]$/, cjkStart = /^[㐀-鿿＀-￯]/;
    for (const l of ls) {
      const lh = l.y1 - l.y0;
      let host = null;
      for (let i = out.length - 1; i >= 0 && i >= out.length - 6; i--) {
        const b = out[i];
        const bh = b.lh;
        const gap = l.y0 - b.y1;
        const ovl = Math.min(b.x1, l.x1) - Math.max(b.x0, l.x0);
        const narrow = Math.min(b.x1 - b.x0, l.x1 - l.x0);
        const sameSize = lh / bh > 0.75 && lh / bh < 1.33;
        if (sameSize && gap > -0.3 * bh && gap < 0.55 * bh && ovl > 0.5 * narrow) { host = b; break; }
      }
      if (host) {
        const glue = cjkEnd.test(host.text) || cjkStart.test(l.text) ? '' : ' ';
        host.text += glue + l.text;
        host.x0 = Math.min(host.x0, l.x0); host.x1 = Math.max(host.x1, l.x1); host.y1 = Math.max(host.y1, l.y1);
        host.n++;
      } else out.push({ text: l.text, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, lh, n: 1 });
    }
    return out;
  }
 
  const rectVerts = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  // </pure>
 
  /* ══════════════════════════════════════════════════════════════════════
   *  1. ХРАНИЛИЩЕ, СОСТОЯНИЕ, СЕТЬ
   * ══════════════════════════════════════════════════════════════════════ */
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script && GM_info.script.version) || '';
  /** Телефон/планшет: мобильный браузер (Edge/Chrome для Android и т.п.) или мобильная версия сайта (m., h5.m., detail.m.…). */
  const MOBILE = (() => {
    try {
      return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent || '') ||
        /(^|\.)m\.(?:taobao|tmall)\.com$/i.test(location.hostname);
    } catch (_) { return false; }
  })();
  // Настройки фото и производительности на телефоне — свои (в режиме телефона DevTools хранилище общее с ПК)
  const MOB_KEYS = new Set(['imgTr', 'imgAuto', 'imgThumbs', 'thumbBig', 'imgAhead', 'ocrThreads', 'ocrGpu', 'uiOpen', 'photoAsk']);
  const skey = (k) => (MOBILE && MOB_KEYS.has(k) ? 'm.' + k : k);
  const store = {
    get(key, def) {
      key = skey(key);
      try { if (typeof GM_getValue === 'function') return GM_getValue(key, def); } catch (_) { /* fallthrough */ }
      try { const v = localStorage.getItem('tbrub:' + key); return v === null ? def : JSON.parse(v); } catch (_) { return def; }
    },
    set(key, val) {
      key = skey(key);
      try { if (typeof GM_setValue === 'function') return GM_setValue(key, val); } catch (_) { /* fallthrough */ }
      try { localStorage.setItem('tbrub:' + key, JSON.stringify(val)); } catch (_) { /* ignore */ }
    }
  };
  const numFromStore = (k) => Number(store.get(k, 0)) || 0;
 
  const state = {
    // курс
    manualRate: sanitizeRate(store.get('rate', DEFAULT_RATE)) || DEFAULT_RATE,
    auto: store.get('auto', true) !== false,
    usdtRub: numFromStore('usdtRub'),
    usdtRubTs: numFromStore('usdtRubTs'),
    usdtCnyManual: sanitizeRate(store.get('usdtCny', DEFAULT_USDT_CNY)) || DEFAULT_USDT_CNY,
    cnyAutoOn: store.get('cnyAutoOn', true) !== false,
    cnyAuto: numFromStore('cnyAuto'),
    cnyTs: numFromStore('cnyTs'),
    cnySrc: String(store.get('cnySrc', '')),
    rubError: false,
    cnyError: false,
    rate: DEFAULT_RATE,
    // отображение и функции
    mode: store.get('mode', 'beside') === 'replace' ? 'replace' : 'beside',
    pageTr: store.get('pageTr', true) !== false,        // перевод страницы Google — включён по умолчанию
    searchTr: store.get('searchTr', true) !== false,    // перевод поисковых запросов
    imgTr: store.get('imgTr', true) !== false,          // кнопки перевода картинок
    ocrEngine: ['auto', 'paddle', 'tesseract', 'vision'].includes(store.get('ocrEngine', 'auto')) ? store.get('ocrEngine', 'auto') : 'auto',
    imgAuto: store.get('imgAuto', true) !== false,      // автоперевод фото на странице товара (по умолчанию включён)
    imgThumbs: store.get('imgThumbs', !MOBILE) === true,   // перевод фото в карточках товаров (поиск, лента); на телефоне по умолчанию нет
    thumbBig: store.get('thumbBig', true) !== false,    // миниатюры: только крупный текст (строки ≥ 9px на экране)
    imgAhead: [0, 1, 2, 3].includes(store.get('imgAhead', MOBILE ? 0 : 1)) ? store.get('imgAhead', MOBILE ? 0 : 1) : 1,   // перевод фото заранее: 0 экран … 3 макс
    ocrThreads: Math.max(0, parseInt(store.get('ocrThreads', 0), 10) || 0),   // потоков распознавания; 0 — оптимум по замеру процессора
    ocrGpu: store.get('ocrGpu', false) === true,        // доп. поток распознавания на видеокарте (WebGPU)
    noThumbVideo: store.get('noThumbVideo', false) === true,   // не проигрывать видео на миниатюрах при наведении
    cacheMB: Math.min(5120, Math.max(50, parseInt(store.get('cacheMB', 200), 10) || 200)),   // лимит кэша фото+моделей на сайт
    cacheTTL: ['week', 'month', 'quarter', 'forever'].includes(store.get('cacheTTL', 'quarter')) ? store.get('cacheTTL', 'quarter') : 'quarter',
    sameTab: store.get('sameTab', true) !== false,      // товары и главная — в этой же вкладке (Ctrl/колёсико — как обычно, в новой)
    revWhole: store.get('revWhole', true) !== false,    // отзыв переводится целиком, а не кусками
    revAlbum: store.get('revAlbum', true) !== false,    // «Все отзывы» открываются сеткой фото
    showWeight: store.get('showWeight', true) !== false, // вес товара рядом с ценой
    visionKey: String(store.get('visionKey', ''))       // ключ Google Cloud Vision (для перевода на картинке)
  };
 
  // Телефон: перевод фото включается только после выбора во всплывающем окне (автоматически / по значку / не нужно)
  if (MOBILE && !store.get('photoAsk', null)) { state.imgTr = false; state.imgAuto = false; }

  function usdtCnyEff() { return state.cnyAutoOn && state.cnyAuto > 0 ? state.cnyAuto : state.usdtCnyManual; }
  function calcRate() { return computeRate(state.auto, state.usdtRub, usdtCnyEff(), state.manualRate); }
  state.rate = calcRate();
 
  /** Замер нагрузки: сколько миллисекунд за последнюю минуту съела каждая часть скрипта (видно в панели). */
  const Perf = (() => {
    const buckets = {};                      // имя → [{t, ms}]
    function add(name, ms) {
      const b = buckets[name] || (buckets[name] = []);
      b.push({ t: Date.now(), ms });
      if (b.length > 400) b.splice(0, b.length - 400);
    }
    function wrap(name, fn) {
      return function () {
        const t0 = performance.now();
        try { return fn.apply(this, arguments); } finally { add(name, performance.now() - t0); }
      };
    }
    function summary() {
      const now = Date.now(), out = {};
      for (const k in buckets) {
        const arr = buckets[k].filter((x) => now - x.t < 60000);
        out[k] = { ms: Math.round(arr.reduce((a, x) => a + x.ms, 0)), n: arr.length };
      }
      return out;
    }
    return { add, wrap, summary };
  })();

  /** Запрос через GM_xmlhttpRequest (обход CORS/CSP), fallback — fetch. */
  function httpReq(opts) {
    const { method = 'GET', url, headers = {}, data, timeout = 7000 } = opts;
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method, url, data, timeout,
          headers: Object.assign({ Accept: 'application/json, text/plain, */*' }, headers),
          onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText)
            : reject(Object.assign(new Error('HTTP ' + r.status), { status: r.status, body: r.responseText }))),
          onerror: () => reject(new Error('network error')),
          ontimeout: () => reject(new Error('timeout'))
        });
      } else {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), timeout);
        fetch(url, { method, body: data, headers, signal: ctl.signal })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
          .then(resolve, reject)
          .finally(() => clearTimeout(t));
      }
    });
  }
 
  const gtxUrl = (sl, tl, q) => 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + sl +
    '&tl=' + tl + '&dt=t&q=' + encodeURIComponent(q);
 
  const fmtNum = (n, d) => n.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
 
  /* ══════════════════════════════════════════════════════════════════════
   *  2. СТИЛИ
   * ══════════════════════════════════════════════════════════════════════ */
  const CSS = `
.tb-rub{display:inline-block;margin:0 4px 0 6px;padding:0 5px;border-radius:4px;background:#fff1e6;color:#ff5000;
  font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:max(11px,.72em);font-weight:600;line-height:1.5;
  vertical-align:middle;white-space:nowrap;letter-spacing:0;text-decoration:none!important;text-transform:none;flex:none}
.tb-rub.tb-rub-compact{margin:0 0 0 3px;padding:0 3px;font-size:.85em}
/* Узкая плашка цены (карусели на главной): рубли второй строкой внутри той же плашки */
.tb-rub.tb-rub-stack{display:block!important;width:max-content;max-width:100%;margin:2px auto 1px!important;padding:0 4px!important;
  font-size:11px!important;line-height:1.3!important;text-align:center;background:#fff1e6!important;color:#ff5000!important}
.tb-rub.tb-rub-gone{display:none!important}
.tb-rub.tb-rub-replace{margin:0 6px 0 0;padding:0;background:transparent;line-height:1.15;vertical-align:baseline}
[data-rub-hide]{display:none!important}
[data-rub-full]{font-size:0!important;letter-spacing:0!important}
[data-rub-full]>*:not(.tb-rub){display:none!important}
[data-rub-full]::before,[data-rub-full]::after{display:none!important}
/* Русский текст длиннее китайского: при включённом переводе снимаем жёсткую обрезку заголовков */
html.tbrub-tr [class*="MainTitle--"],html.tbrub-tr [class*="mainTitle--"]{white-space:normal!important;display:block!important;
  -webkit-line-clamp:unset!important;max-height:none!important;height:auto!important;overflow:visible!important;text-overflow:clip!important}
html.tbrub-tr [class*="ItemHeadFixed--"] [class*="MainTitle--"],html.tbrub-tr [class*="ItemHeadFixed--"] [class*="mainTitle--"]{
  white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
/* Обрезанные заголовки карточек: оригинал не трогаем (его рисует React), перевод — поверх, в тех же размерах.
   Геометрия карточки не меняется → Taobao не перестраивает сетку → страница не «дёргается». */
html.tbrub-tr [data-tbrub-tt]{position:relative!important;color:transparent!important}
html.tbrub-tr [data-tbrub-tt]>*{visibility:hidden!important}
html.tbrub-tr [data-tbrub-tt]::after{content:attr(data-tbrub-tt);position:absolute;left:0;top:0;right:0;bottom:0;visibility:visible;
  color:var(--tbrub-c,#333);font-size:var(--tbrub-fs,12px);line-height:var(--tbrub-lh,1.2);font-weight:400;text-align:left;
  font-family:-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",Arial,sans-serif;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--tbrub-n,2);overflow:hidden;white-space:normal;
  text-overflow:ellipsis;overflow-wrap:anywhere;text-indent:0;letter-spacing:0;pointer-events:none}
html.tbrub-tr [data-tbrub-tt]:hover::after{bottom:auto;display:block;-webkit-line-clamp:unset;background:#fff;color:#222;z-index:20;
  box-shadow:0 3px 10px rgba(0,0,0,.2);border-radius:4px;padding:0 3px 2px 0}
/* Верхнее меню (site-nav): русские подписи длиннее — запрещаем перенос внутри пунктов */
html.tbrub-tr #J_SiteNavBd .site-nav-menu-hd{white-space:nowrap!important}
html.tbrub-tr #J_SiteNavBd>.site-nav-bd-l>li{margin-right:10px!important}
html.tbrub-tr #J_SiteNavBd>.site-nav-bd-r>li{margin-left:10px!important}
/* Лента «Вам может понравиться» на главной: заголовок в 2 строки вместо одной обрезанной (одинаково у всех карточек — сетка не прыгает) */
html.tbrub-tr body .tb-pick-content-item .info-wrapper.single-line{height:40px!important;margin-bottom:2px!important}
html.tbrub-tr body .tb-pick-content-item .info-wrapper.single-line>.info-wrapper-title{display:-webkit-box!important;-webkit-box-orient:vertical!important;
  -webkit-line-clamp:2!important;height:40px!important;max-height:40px!important;overflow:hidden!important;line-height:20px!important;font-size:13.5px!important;white-space:normal!important}
/* Карточка товара: бегущая строка «AI-подбор» над вариантами рассчитана на одну строку */
html.tbrub-tr [class*="SKUDecision--"] [class*="textWrap--"]{white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;max-height:24px!important}
/* Отзыв целиком: оригинал (разрезанный на куски) скрыт, перевод — нашим блоком */
[data-tbrub-rev]{font-size:0!important}
[data-tbrub-rev]>.tbrub-rev{display:block;white-space:pre-wrap;color:inherit;font-family:inherit;letter-spacing:normal;margin:0}
.tbrub-weight{display:inline-block;margin:0 0 0 8px;padding:1px 7px;border-radius:999px;background:#fff;color:#333;border:1px solid rgba(0,0,0,.12);
  font:600 12px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;vertical-align:middle;white-space:nowrap}
/* Корзина: подпись цены над ценой (а не в одну строку с ней), варианты без разрыва слов по буквам */
html.tbrub-tr .trade-cart-item-price .trade-price-container{white-space:normal!important}
html.tbrub-tr .trade-cart-item-price .trade-price-label{display:block!important;white-space:normal!important}
html.tbrub-tr [class*="trade-cart-item-sku"] [class*="label--"],html.tbrub-tr [class*="trade-cart-item-sku"] [class*="content--"]{word-break:normal!important;overflow-wrap:anywhere!important}
/* Подсказки и плейсхолдер поиска: Taobao берёт их текст при клике, поэтому оригинал остаётся в DOM,
   но показываем только перевод */
[data-tbrub-ann]{font-size:0!important;letter-spacing:0!important}
[data-tbrub-ann]::after{content:attr(data-tbrub-ann);font-size:var(--tbrub-ann-fs,14px);letter-spacing:normal}
 
/* Шапка поиска: переведённые подписи кнопок шире 72px — переносим, не ломая геометрию */
html body .search-suggest-buttons-wrapper>div[class^="search-suggest-button"]{box-sizing:border-box!important;padding:0 3px!important;
  white-space:normal!important;word-break:normal!important;text-align:center!important;overflow:hidden!important;
  font-size:11px!important;font-weight:500!important;line-height:1.15!important}
html body #J_Search div[data-sg-type="placeholder"]{max-width:calc(100% - 200px)!important;overflow:hidden!important}
html body div[data-sg-type="placeholder"] .item{display:block!important;overflow:hidden!important;white-space:nowrap!important;
  text-overflow:ellipsis!important;max-width:100%!important}
 
#tbrub-root{all:initial;position:fixed;right:14px;bottom:14px;z-index:999999;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  font-size:12px;line-height:1.3;color:#fff}
#tbrub-root *{box-sizing:border-box;font-family:inherit}
#tbrub-root .tbrub-pill{all:unset;display:flex;align-items:center;gap:7px;padding:7px 12px;background:rgba(28,28,32,.93);color:#fff;
  border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;user-select:none;font-size:12px;font-weight:600;white-space:nowrap}
#tbrub-root .tbrub-pill:hover{background:rgba(45,45,52,.96)}
#tbrub-root .tbrub-dot{width:8px;height:8px;border-radius:50%;background:#9aa0a6;flex:none}
#tbrub-root .tbrub-dot.ok{background:#3ddc84}
#tbrub-root .tbrub-dot.stale{background:#ffb020}
#tbrub-root .tbrub-tag{font-size:11px;font-weight:600;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.14);color:#cfd3da}
#tbrub-root .tbrub-tag.on{background:#ff5000;color:#fff}
#tbrub-root .tbrub-panel{position:absolute;right:0;bottom:44px;width:320px;max-height:calc(100vh - 80px);overflow:auto;padding:12px;background:#1f2024;color:#e8eaed;border-radius:12px;
  box-shadow:0 10px 30px rgba(0,0,0,.45);display:flex;flex-direction:column;gap:10px}
#tbrub-root .tbrub-panel[hidden]{display:none}
#tbrub-root .tbrub-h{font-size:11px;font-weight:600;color:#9aa0a6;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px}
#tbrub-root .tbrub-big{font-size:18px;font-weight:700;color:#fff}
#tbrub-root .tbrub-sub{font-size:11px;color:#9aa0a6;line-height:1.4;word-break:break-word}
#tbrub-root .tbrub-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
#tbrub-root .tbrub-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#e8eaed}
#tbrub-root button.tbrub-b{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;
  font-size:12px;line-height:1.3;white-space:nowrap}
#tbrub-root button.tbrub-b:hover{background:rgba(255,255,255,.24)}
#tbrub-root button.tbrub-b.sel{background:#ff5000}
#tbrub-root button.tbrub-t{all:unset;cursor:pointer;width:36px;height:20px;border-radius:999px;background:#5f6368;position:relative;flex:none}
#tbrub-root button.tbrub-t::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
#tbrub-root button.tbrub-t.on{background:#ff5000}
#tbrub-root button.tbrub-t.on::after{left:18px}
#tbrub-root .tbrub-sep{height:1px;background:rgba(255,255,255,.1)}
#tbrub-root .tbrub-val{font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
#tbrub-root input.tbrub-range{-webkit-appearance:none;appearance:none;display:block;width:100%;height:6px;margin:8px 0 4px;padding:0;border:0;
  border-radius:999px;background:#5f6368;outline:none;cursor:pointer}
#tbrub-root input.tbrub-range:disabled{opacity:.5;cursor:default}
#tbrub-root input.tbrub-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;
  background:#fff;border:2px solid #ff5000;box-shadow:0 1px 4px rgba(0,0,0,.45)}
#tbrub-root input.tbrub-range::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:#fff;border:2px solid #ff5000}
#tbrub-root .tbrub-ticks{display:flex;justify-content:space-between;font-size:10px;color:#9aa0a6;margin-bottom:2px}
#tbrub-root .tbrub-ticks span.sel{color:#fff;font-weight:600}
#tbrub-root .tbrub-ver{font-size:10px;color:#6f747a;text-align:right}
#tbrub-root button.tbrub-hbtn{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#9aa0a6;
  text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;user-select:none}
#tbrub-root button.tbrub-hbtn:hover{color:#e8eaed}
#tbrub-root .tbrub-chev{display:inline-block;width:10px;transition:transform .15s}
#tbrub-root .tbrub-sec.closed .tbrub-chev{transform:rotate(-90deg)}
#tbrub-root .tbrub-sec.closed button.tbrub-hbtn{margin:0}
#tbrub-root .tbrub-body{display:flex;flex-direction:column;gap:6px}
#tbrub-root .tbrub-body[hidden]{display:none}
#tbrub-root .tbrub-h2{font-size:11px;font-weight:600;color:#9aa0a6;margin-top:4px}
#tbrub-root .tbrub-lab{display:inline-flex;align-items:center;gap:4px}
#tbrub-root .tbrub-q{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;flex:none;
  background:rgba(255,255,255,.14);color:#cfd3da;font-size:10px;font-weight:700;cursor:help;white-space:pre-line}
#tbrub-root .tbrub-presets button.tbrub-b{padding:5px 12px}
#tbrub-root .tbrub-brand{display:flex;align-items:baseline;gap:8px;margin:-2px 0 -2px}
#tbrub-root .tbrub-brand b{font-size:15px;font-weight:800;color:#fff;letter-spacing:.01em}
#tbrub-root .tbrub-brand b i{font-style:normal;color:#ff5000}
#tbrub-root .tbrub-brand span{font-size:11px;color:#9aa0a6}
#tbrub-root .tbrub-work{font-size:11px;font-weight:600;padding:1px 6px;border-radius:999px;background:#ff5000;color:#fff}
#tbrub-root .tbrub-work[hidden]{display:none}
#tbrub-root .tbrub-numbox{display:inline-flex;align-items:center;gap:4px;color:#9aa0a6}
#tbrub-root input.tbrub-num{all:unset;width:56px;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.12);color:#fff;font-size:12px;text-align:right}
#tbrub-notice{all:initial;position:fixed;right:14px;bottom:60px;z-index:999999;max-width:330px;padding:10px 12px;border-radius:12px;
  background:#1f2024;color:#e8eaed;font:12px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45)}
#tbrub-notice b{color:#fff}
#tbrub-notice .row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
#tbrub-notice button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font-size:12px}
#tbrub-notice button.main{background:#ff5000}
#tbrub-notice .x{position:absolute;right:8px;top:4px;background:none;padding:2px 4px;color:#9aa0a6}
/* Перевод на картинке */
.tbrub-ocr{position:absolute;left:0;top:0;overflow:hidden;pointer-events:none;z-index:3;margin:0;padding:0;border:0}
.tbrub-ocr-g{position:absolute;left:0;top:0;transform-origin:0 0}
.tbrub-ocr-b{position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden;box-sizing:border-box;
  border-radius:3px;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.tbrub-ocr-b span{display:block;width:100%;text-align:center;line-height:1.1;font-weight:500;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:normal;word-break:normal;hyphens:manual}
#tbrub-imgbtn{all:initial;position:fixed;z-index:999998;display:none;flex-direction:column;gap:6px}
#tbrub-imgbtn.row{flex-direction:row}
#tbrub-imgbtn button{all:unset;cursor:pointer;box-sizing:border-box;width:30px;height:30px;border-radius:50%;background:rgba(28,28,32,.84);color:#fff;
  display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.35);font:600 13px/1 -apple-system,"Segoe UI",Roboto,Arial,sans-serif}
#tbrub-imgbtn button:hover{background:#ff5000;transform:scale(1.08)}
#tbrub-imgbtn button.here{background:#ff5000;font-size:15px}
#tbrub-imgbtn button.here:hover{background:#ff7a3c}
#tbrub-imgbtn button img{width:18px;height:18px;display:block;border-radius:3px;pointer-events:none}
#tbrub-imgbtn button span{pointer-events:none}
.tbrub-ocr.tbrub-under-video{display:none!important}
#tbrub-toast{all:initial;position:fixed;right:14px;top:14px;z-index:999999;max-width:360px;padding:8px 12px;border-radius:10px;pointer-events:none;
  background:rgba(28,28,32,.95);color:#fff;font:12px/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)}
/* ── Телефон: панель — шторка снизу, крупные кнопки, значок «文» на фото ── */
#tbrub-root .tbrub-grip,#tbrub-root .tbrub-back{display:none}
#tbrub-root.mob{right:10px;bottom:calc(64px + env(safe-area-inset-bottom,0px));font-size:14px;z-index:1000000}
#tbrub-root.mob .tbrub-pill{padding:8px 12px;font-size:13px;gap:6px}
#tbrub-root.mob .tbrub-back{display:block;position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.45);touch-action:none}
#tbrub-root.mob .tbrub-back[hidden]{display:none}
#tbrub-root.mob .tbrub-panel{position:fixed;left:0;right:0;bottom:0;width:auto;max-height:82vh;border-radius:16px 16px 0 0;
  padding:0 16px calc(18px + env(safe-area-inset-bottom,0px));gap:12px;font-size:14px;overscroll-behavior:contain}
#tbrub-root.mob .tbrub-grip{display:block;flex:none;align-self:stretch;height:22px;margin:0 -16px -6px;cursor:pointer;position:relative}
#tbrub-root.mob .tbrub-grip::after{content:"";position:absolute;left:50%;top:9px;width:44px;height:5px;margin-left:-22px;border-radius:3px;background:#5f6368}
#tbrub-root.mob button.tbrub-b{padding:8px 14px;font-size:14px}
#tbrub-root.mob .tbrub-presets button.tbrub-b{padding:8px 16px}
#tbrub-root.mob button.tbrub-t{width:46px;height:28px}
#tbrub-root.mob button.tbrub-t::after{top:3px;left:3px;width:22px;height:22px}
#tbrub-root.mob button.tbrub-t.on::after{left:21px}
#tbrub-root.mob .tbrub-sw{font-size:14px;min-height:34px}
#tbrub-root.mob .tbrub-sub{font-size:12px}
#tbrub-root.mob .tbrub-big{font-size:20px}
#tbrub-root.mob button.tbrub-hbtn{font-size:12px;padding:8px 0;margin:0}
#tbrub-root.mob .tbrub-q{width:22px;height:22px;font-size:12px}
#tbrub-root.mob input.tbrub-range{height:8px;margin:12px 0 6px}
#tbrub-root.mob input.tbrub-range::-webkit-slider-thumb{width:24px;height:24px}
#tbrub-root.mob input.tbrub-num{width:72px;padding:6px 8px;font-size:14px}
html.tbrub-mob #tbrub-notice{left:10px;right:10px;bottom:calc(112px + env(safe-area-inset-bottom,0px));max-width:none;font-size:14px;padding:12px 14px}
html.tbrub-mob #tbrub-notice button{padding:8px 14px;font-size:14px}
html.tbrub-mob #tbrub-notice .x{padding:4px 8px;font-size:18px}
html.tbrub-mob #tbrub-toast{left:10px!important;right:10px!important;top:auto;bottom:calc(112px + env(safe-area-inset-bottom,0px));max-width:none;font-size:14px;text-align:center}
html.tbrub-mob #tbrub-imgbtn{gap:8px}
html.tbrub-mob #tbrub-imgbtn button{width:40px;height:40px}
html.tbrub-mob #tbrub-imgbtn button img{width:22px;height:22px}
.tbrub-tap{all:unset;position:absolute;z-index:4;box-sizing:border-box;width:34px;height:34px;border-radius:50%;background:#ff5000;color:#fff;
  display:flex;align-items:center;justify-content:center;font:600 17px/1 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  box-shadow:0 2px 8px rgba(0,0,0,.35);opacity:.93;-webkit-tap-highlight-color:transparent;touch-action:manipulation;cursor:pointer;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.tbrub-tap.busy,.tbrub-tap.shown{background:rgba(28,28,32,.86)}
`;
 
  /** Выполнить, когда появится <html> (на document-start его может ещё не быть). */
  function whenRoot(fn) {
    if (document.documentElement) { fn(); return; }
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); fn(); } });
    mo.observe(document, { childList: true });
  }
 
  function addStyle(css) {
    whenRoot(() => {
      try { if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; } } catch (_) { /* fallthrough */ }
      const st = document.createElement('style');
      st.textContent = css;
      (document.head || document.documentElement).appendChild(st);
    });
  }
 
  let toastTimer = 0;
  /** Всплывающее сообщение. anchor — элемент, под которым показать (например, строка поиска), иначе — справа вверху. */
  function toast(text, ms, anchor) {
    if (!document.body) return;
    let el = document.getElementById('tbrub-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tbrub-toast';
      el.setAttribute('translate', 'no');
      el.className = 'notranslate';
      document.body.appendChild(el);
    }
    el.textContent = text;
    const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    if (r && r.width) {
      el.style.left = Math.max(8, Math.min(r.left, innerWidth - 380)) + 'px';
      el.style.top = Math.min(innerHeight - 60, r.bottom + 6) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    } else { el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; }   // телефон — снизу, над панелью
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms || 2500);
  }
 
  /* ══════════════════════════════════════════════════════════════════════
   *  3. КУРС: Rapira USDT/RUB ÷ USDT/CNY (P2P Binance/OKX → форекс OKX/Sina)
   * ══════════════════════════════════════════════════════════════════════ */
  const RATE_TTL_MS = 5 * 60 * 1000;
  const fresh = (ts) => ts > 0 && Date.now() - ts < RATE_TTL_MS;
 
  async function fetchRub() {
    try {
      const v = parseRapira(JSON.parse(await httpReq({ url: 'https://api.rapira.net/open/market/rates', timeout: 15000 })));
      if (!v) throw new Error('USDT/RUB не найден в ответе Rapira');
      state.usdtRub = v; state.usdtRubTs = Date.now(); state.rubError = false;
      store.set('usdtRub', v); store.set('usdtRubTs', state.usdtRubTs);
    } catch (e) {
      state.rubError = true;
      console.warn('[tb-rub] Rapira недоступна:', e);
    }
  }
 
  const CNY_SOURCES = {
    binance: () => httpReq({
      method: 'POST',
      url: 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ page: 1, rows: 10, payTypes: [], asset: 'USDT', tradeType: 'SELL', fiat: 'CNY', publisherType: null })
    }).then((t) => parseBinanceP2P(JSON.parse(t))),
    okxP2p: () => httpReq({
      url: 'https://www.okx.com/v3/c2c/tradingOrders/books?t=' + Date.now() +
        '&quoteCurrency=CNY&baseCurrency=USDT&side=sell&paymentMethod=all&userType=all&showTrade=false' +
        '&receivingAds=false&showFollow=false&showAlreadyTraded=false&isAbleFilter=false'
    }).then((t) => parseOkxP2P(JSON.parse(t))),
    okxFx: () => httpReq({ url: 'https://www.okx.com/api/v5/market/exchange-rate' }).then((t) => parseOkxFx(JSON.parse(t))),
    sina: () => httpReq({ url: 'https://hq.sinajs.cn/list=fx_susdcny', headers: { Referer: 'https://finance.sina.com.cn/' } }).then(parseSinaFx)
  };
 
  async function fetchCny() {
    const keys = Object.keys(CNY_SOURCES);
    const res = await Promise.allSettled(keys.map((k) => CNY_SOURCES[k]()));
    const got = {};
    res.forEach((r, i) => { got[keys[i]] = r.status === 'fulfilled' ? r.value : null; });
    console.info('[tb-rub] USDT/CNY источники:', got,
      res.map((r, i) => (r.status === 'rejected' ? keys[i] + ': ' + (r.reason && r.reason.message) : null)).filter(Boolean));
    const pick = pickUsdtCny(got);
    if (!pick) { state.cnyError = true; return; }
    state.cnyAuto = pick.value; state.cnyTs = Date.now(); state.cnyError = false;
    state.cnySrc = pick.kind + ': ' + pick.parts.map((x) => x[0] + ' ' + fmtNum(x[1], 2)).join(', ');
    store.set('cnyAuto', state.cnyAuto); store.set('cnyTs', state.cnyTs); store.set('cnySrc', state.cnySrc);
  }
 
  function applyRate() {
    const r = calcRate();
    const changed = r !== state.rate;
    state.rate = r;
    if (changed && document.body) Prices.fullScan();
    Ui.render();
  }
 
  /** Обновляет оба курса (кэш 5 минут, общий для вкладок). */
  async function syncRates(force) {
    if (!state.auto) { applyRate(); return; }
    if (numFromStore('usdtRubTs') > state.usdtRubTs) { state.usdtRub = numFromStore('usdtRub'); state.usdtRubTs = numFromStore('usdtRubTs'); }
    if (numFromStore('cnyTs') > state.cnyTs) {
      state.cnyAuto = numFromStore('cnyAuto'); state.cnyTs = numFromStore('cnyTs'); state.cnySrc = String(store.get('cnySrc', ''));
    }
    const jobs = [];
    if (force || !fresh(state.usdtRubTs)) jobs.push(fetchRub());
    if (state.cnyAutoOn && (force || !fresh(state.cnyTs))) jobs.push(fetchCny());
    if (jobs.length) await Promise.all(jobs);
    applyRate();
  }
 
  /* ══════════════════════════════════════════════════════════════════════
   *  4. ЦЕНЫ ¥ → ₽
   *  Модель «сегмента»: [символ ¥] + [соседние узлы с цифрами] (поиск, главная, карточка),
   *  либо цена целиком в одном элементе («¥0.3», «约省¥0.68»). Хэшированные классы не нужны.
   * ══════════════════════════════════════════════════════════════════════ */
  const IGNORE_SEL = '#tbrub-root,#tbrub-toast,#tbrub-imgbtn,#tbrub-notice,.tbrub-tap,.tbrub-ocr,.tb-rub,.tbrub-rev,.tbrub-weight,script,style,noscript,textarea,template';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
 
  function ownText(el) {
    if (el.nodeType === 3) return el.nodeValue.replace(/\s+/g, ' ').trim();
    let out = '';
    (function walk(n) {
      for (let c = n.firstChild; c && out.length <= 220; c = c.nextSibling) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && !c.classList.contains('tb-rub') && !SKIP_TAGS.has(c.tagName)) walk(c);
      }
    })(el);
    return out.replace(/\s+/g, ' ').trim();
  }
 
  const Prices = (() => {
    const recs = new Map();          // anchor (Element | Text) → запись сегмента
    const partOf = new WeakMap();    // узел сегмента → anchor
 
    /** Числовые узлы, идущие сразу после символа ¥. */
    function collectNums(anchor) {
      let acc = '', nodes = [], best = null;
      for (let s = anchor.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === 8) continue;
        if (s.nodeType === 1 && s.classList.contains('tb-rub')) continue;
        if (s.nodeType !== 1 && s.nodeType !== 3) continue;
        if (s.nodeType === 1 && SKIP_TAGS.has(s.tagName)) continue;
        const t = (s.nodeType === 3 ? s.nodeValue : ownText(s)).replace(/\s+/g, '');
        if (!t) continue;                                    // пустые иконки/пробелы
        if (!isNumFrag(t) || !canAppendFrag(acc, t)) break;
        acc += t;
        nodes.push(s);
        const r = parseNumPart(acc);
        if (r) best = { nodes: nodes.slice(), info: r, text: acc };
      }
      return best;
    }
 
    /** Самый внутренний элемент, чей текст целиком — цена (подпись допускается). */
    function findWhole(start) {
      let cur = start, found = null, fi = null;
      for (let i = 0; cur && cur !== document.body && i < 4; i++, cur = cur.parentElement) {
        const t = ownText(cur);
        if (t.length > 100) break;
        const info = parsePrice(t, true);
        if (info) { if (!found || info.lo !== fi.lo || info.hi !== fi.hi) { found = cur; fi = info; } }
        else if (found) break;
      }
      return found ? { anchor: found, kind: 'whole', nodes: [found], info: fi, sig: ownText(found) } : null;
    }
 
    /** Определение сегмента по текстовому узлу со знаком ¥. */
    function detectAt(textNode) {
      const p = textNode.parentElement;
      if (!p || p.closest(IGNORE_SEL)) return null;
      const v = textNode.nodeValue.trim();
      if (/^[¥￥]$/.test(v)) {
        let a = ownText(p) === v ? p : textNode;              // элемент-символ или голый текстовый узел
        if (a === textNode) {                                  // «¥» голым текстом рядом с числом: лучше целиком
          const whole = findWhole(p);
          if (whole) return whole;
        }
        for (let i = 0; i < 2 && a.nodeType === 1 && a.parentElement && ownText(a.parentElement) === v; i++) a = a.parentElement;
        const n = collectNums(a);
        if (n) return { anchor: a, kind: 'sym', nodes: [a].concat(n.nodes), info: n.info, sig: v + n.text };
      }
      return findWhole(p);
    }
 
    /** Повторное определение для существующей записи (смена SKU, перерисовка React). */
    function redetect(rec) {
      if (!rec.anchor.isConnected) return null;
      if (rec.kind === 'sym') {
        const n = collectNums(rec.anchor);
        return n ? { anchor: rec.anchor, kind: 'sym', nodes: [rec.anchor].concat(n.nodes), info: n.info, sig: ownText(rec.anchor) + n.text } : null;
      }
      const t = ownText(rec.anchor);
      const info = parsePrice(t, rec.kind === 'whole');
      return info ? { anchor: rec.anchor, kind: rec.kind, nodes: [rec.anchor], info, sig: t } : null;
    }
 
    function sameNodes(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
 
    function badgeOk(rec) {
      const b = rec.badge;
      if (!b || !b.isConnected) return false;
      if (rec.kind === 'sym') return rec.nodes[rec.nodes.length - 1].nextSibling === b;
      return b.parentNode === rec.anchor;
    }
 
    function unpaint(rec) {
      if (rec.badge && rec.badge.parentNode) rec.badge.remove();
      for (const n of rec.nodes) {
        if (n.nodeType === 1) n.removeAttribute('data-rub-hide');
        partOf.delete(n);
      }
      if (rec.anchor.nodeType === 1) {
        rec.anchor.removeAttribute('data-rub-done');
        rec.anchor.removeAttribute('data-rub-full');
      }
      recs.delete(rec.anchor);
    }
 
    /** Стиль цифр для режима «Замена» (читается до записи — без layout thrashing). */
    function readStyle(seg) {
      let host = null;
      for (const n of seg.nodes) {
        if (n.nodeType === 1 && /\d/.test(ownText(n))) {
          const tw = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
          let t;
          while ((t = tw.nextNode())) if (/\d/.test(t.nodeValue)) { host = t.parentElement; break; }
          if (host) break;
        }
      }
      host = host || (seg.anchor.nodeType === 1 ? seg.anchor : seg.anchor.parentElement);
      const cs = getComputedStyle(host);
      return { fontSize: parseFloat(cs.fontSize) > 0 ? cs.fontSize : '16px', fontWeight: cs.fontWeight, color: cs.color, fontFamily: cs.fontFamily };
    }
 
    function paint(seg, style) {
      const { info } = seg;
      const rub = info.hi !== null && info.hi !== info.lo
        ? formatRub(info.lo, state.rate) + '–' + formatRub(info.hi, state.rate) + ' ₽'
        : formatRub(info.lo, state.rate) + ' ₽';
      const badge = document.createElement('span');
      badge.className = 'tb-rub notranslate';
      badge.setAttribute('translate', 'no');
      const original = seg.sig.replace(/^[^¥￥\d]*/, '');
      const rec = { anchor: seg.anchor, kind: seg.kind, nodes: seg.nodes, sig: seg.sig, rate: state.rate, mode: state.mode, badge, replaced: false };
 
      // «Замена» возможна, если все узлы цены — элементы (их можно скрыть), либо цена целиком в одном элементе
      const canHide = seg.kind === 'sym' && seg.nodes.every((n) => n.nodeType === 1);
      if (state.mode === 'replace' && (canHide || seg.kind !== 'sym')) {
        rec.replaced = true;
        badge.classList.add('tb-rub-replace');
        const pre = seg.kind !== 'sym' ? ruPrefix(info.prefix) : '';
        badge.textContent = (pre ? pre + ' ' : '') + rub;
        badge.title = 'Оригинал: ' + original + ' · 1 ¥ = ' + fmtNum(state.rate, 2) + ' ₽';
        if (style) {
          badge.style.fontSize = style.fontSize; badge.style.fontWeight = style.fontWeight;
          badge.style.color = style.color; badge.style.fontFamily = style.fontFamily;
        }
      } else {
        badge.textContent = '≈ ' + rub;
        badge.title = original + ' · 1 ¥ = ' + fmtNum(state.rate, 2) + ' ₽';
      }
 
      if (seg.kind === 'sym') {
        if (rec.replaced) seg.nodes.forEach((n) => n.setAttribute('data-rub-hide', ''));
        seg.nodes[seg.nodes.length - 1].after(badge);
      } else {
        if (rec.replaced) seg.anchor.setAttribute('data-rub-full', '');
        seg.anchor.appendChild(badge);
      }
      if (seg.anchor.nodeType === 1) seg.anchor.setAttribute('data-rub-done', '');
      seg.nodes.forEach((n) => partOf.set(n, seg.anchor));
      recs.set(seg.anchor, rec);
    }
 
    /** Применяет набор сегментов: решения → снятие старого → чтение стилей → запись. */
    function commit(segs) {
      const jobs = [];
      const seen = new Set();
      for (const seg of segs) {
        if (seen.has(seg.anchor)) continue;
        seen.add(seg.anchor);
        const old = recs.get(seg.anchor);
        if (old) {
          if (old.sig === seg.sig && old.rate === state.rate && old.mode === state.mode &&
              sameNodes(old.nodes, seg.nodes) && badgeOk(old) &&
              (!old.replaced || old.kind !== 'sym' || old.nodes.every((n) => n.hasAttribute('data-rub-hide')))) continue;
          jobs.push({ seg, old });
        } else {
          // узел уже входит в другой сегмент — пропускаем
          if (seg.nodes.some((n) => partOf.has(n) && partOf.get(n) !== seg.anchor)) continue;
          jobs.push({ seg, old: null });
        }
      }
      if (!jobs.length) return;
      for (const j of jobs) if (j.old) unpaint(j.old);
      const styles = state.mode === 'replace' ? jobs.map((j) => readStyle(j.seg)) : [];
      jobs.forEach((j, i) => paint(j.seg, styles[i]));
      fitBadges(jobs.map((j) => recs.get(j.seg.anchor)).filter(Boolean));
    }
 
    /** Узкие ячейки с обрезкой: компактный бейдж → рубли второй строкой → если и так не влезает, рубли в подсказку. */
    function clipped(h) {
      if (!h || h.clientWidth === 0) return false;
      const cs = getComputedStyle(h);
      return (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis') && h.scrollWidth > h.clientWidth + 1;
    }
    /** Бейдж вылез за предка с overflow:hidden, хотя сама цена внутри него видна (карточка уехала из карусели — не в счёт). */
    function outOfClip(b, ref) {
      const r = b.getBoundingClientRect();
      if (!r.width) return false;                     // скрыт целиком (неактивная вкладка/слайд) — решим позже
      const p = ref && ref.getBoundingClientRect ? ref.getBoundingClientRect() : null;
      const inside = (x, c) => x.left >= c.left - 1 && x.right <= c.right + 1 && x.top >= c.top - 1 && x.bottom <= c.bottom + 1;
      for (let a = b.parentElement, i = 0; a && i < 6 && a !== document.body; a = a.parentElement, i++) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        if (p && p.width && !inside(p, c)) continue;
        if (!inside(r, c)) return true;
      }
      return false;
    }
    const refOf = (r) => (r.anchor.nodeType === 1 ? r.anchor : r.anchor.parentElement);
    const tightRec = (r) => r.badge.isConnected && (outOfClip(r.badge, refOf(r)) || clipped(r.badge.parentElement) ||
      clipped(r.badge.parentElement && r.badge.parentElement.parentElement));
    function fitBadges(list) {
      const beside = list.filter((r) => !r.replaced && r.badge.isConnected);
      if (!beside.length) return;
      requestAnimationFrame(() => {
        const tight = beside.filter(tightRec);
        if (!tight.length) return;
        tight.forEach((r) => { r.badge.classList.add('tb-rub-compact'); r.badge.textContent = r.badge.textContent.replace('≈ ', '≈'); });
        requestAnimationFrame(() => {
          const still = tight.filter(tightRec);
          still.forEach((r) => {
            r.badge.classList.remove('tb-rub-compact');
            r.badge.classList.add('tb-rub-stack');
            r.badge.textContent = r.badge.textContent.replace(/^≈\s*/, '≈ ');
          });
          requestAnimationFrame(() => {
            still.filter(tightRec).forEach((r) => {
              r.badge.classList.remove('tb-rub-stack');
              r.badge.classList.add('tb-rub-gone');
              const host = r.anchor.nodeType === 1 ? r.anchor : r.anchor.parentElement;
              if (host && !host.title) host.title = r.badge.title.replace(/ ·.*/, '') + ' ' + r.badge.textContent;
            });
          });
        });
      });
    }

    /** Проверка всех существующих записей: удалённые → убрать бейдж, изменённые → перерисовать. */
    function sweep(out) {
      for (const rec of Array.from(recs.values())) {
        const seg = redetect(rec);
        if (!seg) { unpaint(rec); continue; }
        out.push(seg);
      }
    }
 
    function collect(root, out) {
      if (!root || root.nodeType !== 1 || root.closest(IGNORE_SEL)) return;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) {
        const v = n.nodeValue;
        if (v.indexOf('¥') < 0 && v.indexOf('￥') < 0) continue;
        if (partOf.has(n) || (n.parentElement && partOf.has(n.parentElement) && recs.has(partOf.get(n.parentElement)))) continue;
        const seg = detectAt(n);
        if (seg) out.push(seg);
      }
      // цены без символа ¥ в DOM (символ нарисован CSS)
      const SEL = '[class*="priceInt"]';
      const hints = Array.from(root.querySelectorAll(SEL));
      if (root.matches && root.matches(SEL)) hints.unshift(root);
      for (const el of hints) {
        let covered = false;
        for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) if (partOf.has(a)) { covered = true; break; }
        if (covered || el.closest(IGNORE_SEL)) continue;
        const w = el.parentElement;
        if (!w) continue;
        const sib = w.previousElementSibling;
        if (sib && /^[¥￥]$/.test(ownText(sib))) continue;   // будет найдено как сегмент с символом
        const t = ownText(w);
        if (NOSYM_RE.test(t) && num(t) > 0) out.push({ anchor: w, kind: 'nosym', nodes: [w], info: { prefix: '', lo: num(t), hi: null }, sig: t });
      }
    }
 
    function scanRoots(roots) {
      const t0 = performance.now();
      try { scanRootsRaw(roots); } finally { Perf.add('Цены', performance.now() - t0); }
    }
    function scanRootsRaw(roots) {
      const segs = [];
      sweep(segs);
      for (const r of roots) if (r && r.isConnected) collect(r, segs);
      commit(segs);
    }
 
    return {
      scanRoots,
      fullScan() { if (document.body) scanRoots([document.body]); },
      count: () => recs.size
    };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  5. ПЕРЕВОД СТРАНИЦЫ (Google, zh → ru)
   *  Переводим только то, что рядом с экраном (IntersectionObserver), догружаемые блоки — через
   *  общий MutationObserver. Оригиналы хранятся, выключение восстанавливает текст без перезагрузки.
   * ══════════════════════════════════════════════════════════════════════ */
  const TL = 'ru';
  const TR_SKIP_SEL = '#tbrub-root,#tbrub-toast,#tbrub-imgbtn,#tbrub-notice,.tbrub-tap,.tbrub-ocr,.tb-rub,.tbrub-rev,.tbrub-weight,script,style,noscript,textarea,code,pre,select,option,[contenteditable=""],[contenteditable="true"]';
  // Подсказки поиска: их текст читает сам Taobao при клике, поэтому перевод показываем рядом, не заменяя
  const TR_ANNOTATE_SEL = '.search-suggest-menu,.search-suggest-popup,[data-sg-type="placeholder"]';
  const TR_MAX_LEN = 400;
  const TR_MAX_ENC = 3500;
  const TR_CONCURRENCY = 3;
  // Заголовки, которые нельзя переводить «на месте» (полный заголовок товара на его странице мы как раз раскрываем)
  const BOX_EXCLUDE_SEL = '[class*="MainTitle--"],[class*="mainTitle--"],' + TR_ANNOTATE_SEL;
  const FIGHT_WINDOW_MS = 20000;   // если страница дважды за это время вернула оригинал — перестаём писать в узел
 
  /* ── Подсказка про вход в Google: перевод идёт через Google Translate, без входа он чаще отказывает ──
   * Показываем один раз при первом запуске и ещё раз, если Google начал отказывать (3+ отказа за 10 минут,
   * не чаще раза в 6 часов). Кнопки: «Войти в Google» / «Уже вошёл» / ×. */
  /** Карточка-подсказка (справа внизу; на телефоне — во всю ширину над нижним меню). Одновременно — одна. */
  function noticeCard(title, text, buttons, onClose) {
    if (!document.body || document.getElementById('tbrub-notice')) return null;
    const el = document.createElement('div');
    el.id = 'tbrub-notice';
    el.className = 'notranslate';
    el.setAttribute('translate', 'no');
    const p = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = title;
    p.append(b, document.createElement('br'), document.createTextNode(text));
    const row = document.createElement('div');
    row.className = 'row';
    const mkb = (t, cls, fn) => {
      const x = document.createElement('button');
      x.type = 'button'; x.textContent = t;
      if (cls) x.className = cls;
      x.addEventListener('click', (e) => { e.stopPropagation(); el.remove(); if (fn) fn(); });
      return x;
    };
    row.append(...buttons.map((bt) => mkb(bt.label, bt.main ? 'main' : '', bt.fn)));
    el.append(mkb('×', 'x', onClose), p, row);
    document.body.appendChild(el);
    return el;
  }

  const GNotice = (() => {
    const KEY = 'gNotice';
    let fails = [];
    const st = () => { const v = store.get(KEY, null); return v && typeof v === 'object' ? v : {}; };
    const save = (patch) => store.set(KEY, Object.assign(st(), patch));
    function show(kind, n) {
      return noticeCard(kind === 'fail' ? 'Google ограничивает перевод' : 'Перевод работает через Google', kind === 'fail'
        ? 'За последние минуты — ' + n + ' ' + plural(n, 'отказ', 'отказа', 'отказов') + '. Войдите в аккаунт Google в этом браузере: со входом лимиты заметно выше, перевод перестанет пропадать.'
        : 'Для стабильной работы войдите в аккаунт Google в этом браузере — без входа Google чаще отказывает («слишком много запросов»), и часть текста остаётся по-китайски.',
      [{ label: 'Войти в Google', main: true, fn: () => { save({ login: Date.now() }); window.open('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Ftranslate.google.com%2F', '_blank', 'noopener'); } },
        { label: 'Уже вошёл', fn: () => save({ ok: Date.now() }) }],
      () => save({ closed: Date.now() }));
    }
    /** Первый запуск: один раз, через несколько секунд после загрузки. */
    function firstRun() {
      if (st().shown) return;
      let tries = 0;
      const go = () => {                               // на экране другая подсказка (телефон: выбор режима фото) — подождём
        if (show('intro')) save({ shown: Date.now() }); else if (++tries < 12) setTimeout(go, 5000);
      };
      setTimeout(go, 4000);
    }
    /** Отказ Google (429/403/503 или страница-капча вместо ответа). */
    function fail(err) {
      const msg = String((err && err.message) || err || '');
      if (!/HTTP (429|403|503)|Unexpected token|JSON|not valid JSON/i.test(msg)) return;
      const now = Date.now();
      fails = fails.filter((t) => now - t < 10 * 60000);
      fails.push(now);
      const s = st();
      if (fails.length >= 3 && (!s.failShown || now - s.failShown > 6 * 3600000)) {
        save({ failShown: now });
        show('fail', fails.length);
      }
    }
    return { firstRun, fail, show };
  })();

  const Translator = (() => {
    const CACHE_KEY = 'pageTrCache2';                 // новая версия: старый кэш содержал ошибки без словаря
    const cache = new Map(Object.entries(store.get(CACHE_KEY, {}) || {}));
    if (store.get('pageTrCache', null)) store.set('pageTrCache', {});
    const written = new WeakMap();   // текстовый узел → значение, которое записали мы
    const original = new WeakMap();  // текстовый узел → оригинал
    const touched = new Set();       // для восстановления при выключении
    const touchedAttr = new Map();   // элемент → {attr: оригинал}
    const waiting = new Map();       // core → [задачи]
    const fails = new Map();         // core → число неудач
    let activated = new WeakSet();
    let observed = new WeakSet();
    let boxSrc = new WeakMap();      // плашка → текст оригинала, для которого она поставлена/заказана
    const boxes = new Set();
    let fight = new WeakMap();       // элемент → {orig:Set, n, t} — сколько раз страница возвращала оригинал
    let contested = new WeakSet();   // элементы, за которые «борется» React: только плашка, без записи в текст
    let io = null;
    let running = 0, timer = 0, pauseUntil = 0, saveTimer = 0;
    // IntersectionObserver иногда не присылает событий (окно свёрнуто/перекрыто, особенности страницы) —
    // тогда раз в секунду сами проверяем, что ждёт перевода рядом с экраном
    const pendingEls = new Set();
    let lastIOAt = 0, ioBroken = false, ioCheck = 0, sweepTimer = 0;
    const NEAR_PX = 1500;
    // отзывы: переводим текст отзыва целиком (Taobao режет его подсветкой ключевых слов на куски)
    const REV_SEL = '[class*="Comment--"] [class*="content--"],[class*="Comment--"] [class*="appendContent--"]';
    const REV_MAX = 900;
    let revSrc = new WeakMap();
    const revs = new Set();
    const stats = { done: 0, errors: 0 };
 
    function persist() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const entries = Array.from(cache.entries());
        const keep = entries.slice(-6000);
        if (keep.length < entries.length) { cache.clear(); keep.forEach(([k, v]) => cache.set(k, v)); }
        store.set(CACHE_KEY, Object.fromEntries(keep));
        saveTimer = 0;
      }, 15000);
    }
    // уходим со страницы — сохраняем сразу, чтобы не потерять последние переводы
    window.addEventListener('pagehide', () => {
      if (!saveTimer) return;
      clearTimeout(saveTimer); saveTimer = 0;
      store.set(CACHE_KEY, Object.fromEntries(Array.from(cache.entries()).slice(-6000)));
    });
 
    const split = (s) => {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
      return { lead: m[1], core: m[2], trail: m[3] };
    };
 
    function skipEl(el) {
      if (!el || el.closest(TR_SKIP_SEL)) return true;
      const nt = el.closest('.notranslate,[translate="no"]');
      return !!(nt && nt !== document.documentElement);
    }
 
    function wanted(text) {
      return CJK_RE.test(text) && !/[¥￥]\s*\d/.test(text);    // текст с ценами не трогаем
    }
 
    function apply(task, tr) {
      if (task.type === 'text') {
        const t = task.node;
        if (!t.isConnected || t.nodeValue !== task.full) return;     // узел успел измениться
        const { lead, trail } = split(task.full);
        if (task.annotate) {
          const p = t.parentElement;
          if (p) {
            if (!p.hasAttribute('data-tbrub-ann')) {
              const fs = task.fs !== undefined ? task.fs : parseFloat(getComputedStyle(p).fontSize);
              if (fs > 0) p.style.setProperty('--tbrub-ann-fs', fs + 'px');
            }
            p.setAttribute('data-tbrub-ann', tr);
          }
          return;
        }
        const nv = lead + tr + trail;
        noteWrite(t, task.full);
        original.set(t, task.full);
        written.set(t, nv);
        touched.add(t);
        t.nodeValue = nv;
        if (t.parentElement) queueClipCheck(t.parentElement);
      } else if (task.type === 'rev') {
        const el = task.el;
        if (!el.isConnected || revSrc.get(el) !== task.full) return;
        let d = el.querySelector(':scope > .tbrub-rev');
        if (!d) {
          const cs = task.cs || getComputedStyle(el);
          d = document.createElement('div');
          d.className = 'tbrub-rev notranslate';
          d.setAttribute('translate', 'no');
          d.style.fontSize = parseFloat(cs.fontSize) > 0 ? cs.fontSize : '14px';
          d.style.lineHeight = cs.lineHeight !== 'normal' && parseFloat(cs.lineHeight) > 0 ? cs.lineHeight : '1.6';
          el.appendChild(d);
        }
        d.textContent = tr;
        d.title = task.full;                       // оригинал — во всплывающей подсказке
        el.setAttribute('data-tbrub-rev', '');
        revs.add(el);
      } else if (task.type === 'tip') {
        const el = task.el;
        if (!el.isConnected) return;
        const rec = touchedAttr.get(el) || {};
        if (!('title' in rec)) rec.title = el.getAttribute('title');
        touchedAttr.set(el, rec);
        el.setAttribute('title', split(task.full).core + ' — ' + tr);
      } else if (task.type === 'box') {
        const box = task.box;
        if (!box.isConnected || normText(box) !== task.full || boxSrc.get(box) !== task.full) return;
        layoutBox(box, task.m);
        box.setAttribute('data-tbrub-tt', tr);
        boxes.add(box);
        const rec = touchedAttr.get(box) || {};
        if (!('title' in rec)) rec.title = box.getAttribute('title');
        touchedAttr.set(box, rec);
        box.setAttribute('title', tr);
      } else {
        const { el, attr } = task;
        if (!el.isConnected || el.getAttribute(attr) !== task.full) return;
        const rec = touchedAttr.get(el) || {};
        if (!(attr in rec)) rec[attr] = task.full;
        touchedAttr.set(el, rec);
        el.setAttribute(attr, tr);
      }
      stats.done++;
    }
 
    /** Обрезанный перевод (многоточие, ограничение строк): полный текст — во всплывающей подсказке. */
    const clipSet = new Set();
    let clipRaf = 0;
    function isClipped(el) {
      if (!el || el.nodeType !== 1 || el.clientWidth === 0) return false;
      const cs = getComputedStyle(el);
      const clips = cs.overflow !== 'visible' || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
      return clips && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2);
    }
    function queueClipCheck(el) {
      clipSet.add(el);
      if (clipRaf) return;
      clipRaf = requestAnimationFrame(() => {
        clipRaf = 0;
        const t0 = performance.now();
        try { clipPass(); } finally { Perf.add('Подгонка подписей', performance.now() - t0); }
      });
    }
    function clipPass() {
      {
        const list = Array.from(clipSet);
        clipSet.clear();
        const hits = list.filter((el) => {
          if (!el.isConnected) return false;
          for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) if (isClipped(a)) return true;
          return false;
        });
        // сначала все замеры, потом все записи — без чередования чтения и записи (иначе браузер пересчитывает раскладку на каждом шаге)
        const plan = hits.map(planShrink).filter(Boolean);
        plan.forEach(([el, fs]) => { el.style.fontSize = fs + 'px'; });
        for (const el of hits) {
          if (el.hasAttribute('title') && CJK_RE.test(el.getAttribute('title')) === false) continue;
          const rec = touchedAttr.get(el) || {};
          if (!('title' in rec)) rec.title = el.getAttribute('title');   // null → при выключении удалить
          touchedAttr.set(el, rec);
          el.setAttribute('title', (el.textContent || '').replace(/\s+/g, ' ').trim());
        }
      }
    }
 
    const normText = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

    /** Короткая подпись не влезла (заголовок плитки, кнопка): уменьшаем шрифт до 80%, без переноса и смены размеров блока. */
    const shrunk = new Set();
    function planShrink(el) {
      if (shrunk.has(el) || !el.isConnected) return null;
      const txt = normText(el);
      if (!txt || txt.length > 32) return null;
      const cs = getComputedStyle(el);
      const f0 = parseFloat(cs.fontSize);
      if (!(f0 >= 11) || el.clientHeight > parseFloat(cs.lineHeight || f0 * 1.4) * 1.6) return null;   // только однострочные
      shrunk.add(el);
      // один шаг вместо перебора: уменьшаем ровно настолько, насколько текст шире своего контейнера (не меньше 80%)
      for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) {
        if (!isClipped(a)) continue;
        const k = a.clientWidth / Math.max(1, a.scrollWidth);
        return [el, Math.max(10, f0 * 0.8, Math.floor(f0 * k * 0.98))];
      }
      return null;
    }
 
    /** Запоминаем, что писали в узел: если страница вернёт оригинал — это «борьба». */
    function noteWrite(t, full) {
      const core = split(full).core;
      for (let a = t.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) {
        const f = fight.get(a) || { orig: new Set(), n: 0, t: 0 };
        f.orig.add(core);
        if (f.orig.size > 30) f.orig.delete(f.orig.values().next().value);
        fight.set(a, f);
      }
    }
 
    /** Новый китайский узел с тем же текстом, что мы уже переводили в этом месте → страница откатила перевод. */
    function checkRevert(t) {
      const core = split(t.nodeValue).core;
      for (let a = t.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) {
        const f = fight.get(a);
        if (!f || !f.orig.has(core)) continue;
        const now = Date.now();
        f.n = now - f.t > FIGHT_WINDOW_MS ? 1 : f.n + 1;
        f.t = now;
        if (f.n >= 2 && !contested.has(a)) {
          contested.add(a);
          console.info('[tb-rub] страница возвращает оригинал — перевод этого блока показываю поверх, не меняя текст', a);
        }
        return;
      }
    }
 
    function isContested(t) {
      for (let a = t.parentElement, i = 0; a && i < 2; a = a.parentElement, i++) if (contested.has(a)) return true;
      return false;
    }
 
    function isClampBox(cs) {
      const n = parseInt(cs.webkitLineClamp, 10);
      return n >= 2;
    }
 
    /** Контейнер, перевод которого показываем «плашкой» поверх (без изменения текста и размеров). */
    function boxFor(t) {
      const p = t.parentElement;
      if (!p) return null;
      const own = p.closest('[data-tbrub-tt]');
      if (own && own.contains(t)) return own;
      let forced = null;
      for (let a = p, i = 0; a && i < 2; a = a.parentElement, i++) if (contested.has(a)) { forced = a; break; }
      for (let a = forced || p, i = 0; a && i < 4 && a !== document.body; a = a.parentElement, i++) {
        const cs = getComputedStyle(a);
        if (cs.display === 'inline' && !forced) continue;
        if (forced || isClampBox(cs)) {
          if (cs.display === 'inline') { forced = null; continue; }
          if (a.matches(BOX_EXCLUDE_SEL) || a.closest(BOX_EXCLUDE_SEL)) return null;
          if (a.clientHeight < 8 || a.clientHeight > 140 || a.clientWidth < 24) return null;
          if (a.querySelector('.tb-rub,input,textarea,select,button')) return null;
          const txt = normText(a);
          if (!txt || txt.length > TR_MAX_LEN || /[¥￥]\s*\d/.test(txt)) return null;
          return a;
        }
      }
      return null;
    }
 
    /** Размер шрифта и число строк плашки — строго внутри исходной рамки. */
    function measureBox(box) {
      const cs = getComputedStyle(box);
      return { h: box.clientHeight, fontSize: cs.fontSize, lineClamp: cs.webkitLineClamp, color: cs.color };
    }
    function layoutBox(box, m) {
      const cs = m || measureBox(box);
      const h = cs.h;
      const f0 = parseFloat(cs.fontSize) || 13;
      const clamp = parseInt(cs.lineClamp, 10) || Math.max(1, Math.round(h / (f0 * 1.3)));
      let n = clamp + 1, lh = h / n, fs = Math.min(f0, lh / 1.12);
      if (fs < 10.5) { n = clamp; lh = h / n; fs = Math.min(f0, lh / 1.12); }
      const st = box.style;
      st.setProperty('--tbrub-n', String(n));
      st.setProperty('--tbrub-lh', lh.toFixed(2) + 'px');
      st.setProperty('--tbrub-fs', fs.toFixed(2) + 'px');
      st.setProperty('--tbrub-c', cs.color === 'rgba(0, 0, 0, 0)' ? '#333' : cs.color);
    }
 
    function enqueueBox(box) {
      const txt = normText(box);
      if (boxSrc.get(box) === txt) return;
      boxSrc.set(box, txt);
      if (box.hasAttribute('data-tbrub-tt')) box.removeAttribute('data-tbrub-tt');   // текст сменился — старый перевод не показываем
      if (!wanted(txt)) return;
      enqueue({ type: 'box', box, full: txt });
    }
 
    /** Текст отзыва без нашего перевода. */
    function revText(el) {
      let out = '';
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) if (!n.parentElement.closest('.tbrub-rev')) out += n.nodeValue;
      return out.replace(/\s+/g, ' ').trim();
    }

    /** true — отзыв взят в работу целиком; false — пусть переводится обычным способом. */
    function enqueueRev(el) {
      const txt = revText(el);
      if (!wanted(txt) || txt.length > REV_MAX) return false;
      if (revSrc.get(el) === txt && el.querySelector(':scope > .tbrub-rev')) return true;
      revSrc.set(el, txt);
      enqueue({ type: 'rev', el, full: txt });
      return true;
    }

    /** Готовые переводы (словарь/кэш) во время обхода страницы копим и вставляем разом в конце:
     *  сначала все замеры, потом все записи — иначе браузер пересчитывает раскладку на каждом узле. */
    let deferred = null;
    function applyLater(task, tr) { if (deferred) deferred.push([task, tr]); else apply(task, tr); }
    function batch(fn) {
      if (deferred) { fn(); return; }
      deferred = [];
      let list;
      try { fn(); } finally { list = deferred; deferred = null; }
      if (!list.length) return;
      const t0 = performance.now();
      for (const [t] of list) {                        // фаза чтения
        try {
          if (t.type === 'box') { if (t.box.isConnected) t.m = measureBox(t.box); }
          else if (t.type === 'text' && t.annotate) { const p = t.node.parentElement; if (p && !p.hasAttribute('data-tbrub-ann')) t.fs = parseFloat(getComputedStyle(p).fontSize); }
          else if (t.type === 'rev' && t.el.isConnected && !t.el.querySelector(':scope > .tbrub-rev')) {
            const c = getComputedStyle(t.el); t.cs = { fontSize: c.fontSize, lineHeight: c.lineHeight };
          }
        } catch (_) { /* узел исчез — apply сам проверит */ }
      }
      for (const [t, tr] of list) apply(t, tr);       // фаза записи
      Perf.add('Вставка перевода текста', performance.now() - t0);
    }

    function enqueue(task) {
      const { core } = split(task.full);
      if (!core || core.length > (task.type === 'rev' ? REV_MAX : TR_MAX_LEN)) return;
      const local = localTranslate(core);
      if (local !== null) { applyLater(task, local); return; }
      const hit = cache.get(core);
      if (hit !== undefined) { applyLater(task, fixRu(hit)); return; }
      if ((fails.get(core) || 0) >= 3) return;
      const list = waiting.get(core);
      if (list) list.push(task); else waiting.set(core, [task]);
      schedule();
    }
 
    function enqueueText(t) {
      if (!state.pageTr) return;
      const v = t.nodeValue;
      if (!v || written.get(t) === v || !wanted(v)) return;
      const p = t.parentElement;
      if (skipEl(p)) return;
      if (state.revWhole) {
        const rev = p.closest(REV_SEL);
        if (rev && enqueueRev(rev)) return;
      }
      checkRevert(t);
      const annotate = !!p.closest(TR_ANNOTATE_SEL);
      const box = annotate ? null : boxFor(t);
      if (box) { enqueueBox(box); return; }
      if (!annotate && isContested(t)) {
        // плашку поставить некуда (слишком маленький элемент) — перевод только во всплывающей подсказке
        if (!p.hasAttribute('title') || CJK_RE.test(p.getAttribute('title'))) enqueue({ type: 'tip', el: p, full: v });
        return;
      }
      enqueue({ type: 'text', node: t, full: v, annotate });
    }
 
    function activate(el) {
      for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) enqueueText(c);
      for (const attr of ['title', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v && wanted(v)) enqueue({ type: 'attr', el, attr, full: v });
      }
    }
 
    function onIntersect(entries) {
      lastIOAt = Date.now();
      ioBroken = false;
      batch(() => onIntersectRaw(entries));
    }
    function onIntersectRaw(entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        pendingEls.delete(e.target);
        activated.add(e.target);
        activate(e.target);
      }
    }

    const nearViewport = (el, below) => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return false;
      return r.bottom > -NEAR_PX / 2 && r.top < innerHeight + (below || NEAR_PX);
    };

    function armIOCheck() {
      if (ioCheck || ioBroken) return;
      const at = Date.now();
      ioCheck = setTimeout(() => {
        ioCheck = 0;
        if (lastIOAt < at && pendingEls.size && !document.hidden) { ioBroken = true; sweep(); }
      }, 1500);
    }

    // Во вкладке в фоне браузер не присылает событий IntersectionObserver — переводим то, что рядом с первым экраном,
    // заранее: открыли товар в фоновой вкладке → переключились → он уже на русском.
    function sweep() {
      if (!io || (!ioBroken && !document.hidden)) return;
      batch(sweepRaw);
    }
    function sweepRaw() {
      for (const el of Array.from(pendingEls)) {
        if (!el.isConnected) { pendingEls.delete(el); continue; }
        if (!nearViewport(el)) continue;
        pendingEls.delete(el);
        io.unobserve(el);
        activated.add(el);
        activate(el);
      }
    }
 
    /** Регистрирует элементы с китайским текстом внутри root. */
    function scan(root) { batch(() => scanRaw(root)); }
    function scanRaw(root) {
      if (!state.pageTr || !io || !root) return;
      if (root.nodeType === 3) { handleText(root); return; }
      if (root.nodeType !== 1 || skipEl(root)) return;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) if (CJK_RE.test(n.nodeValue)) handleText(n);
      // атрибуты title/placeholder у элементов без китайского текста
      root.querySelectorAll('[title],[placeholder]').forEach((el) => {
        const v = el.getAttribute('title') || el.getAttribute('placeholder');
        if (v && CJK_RE.test(v)) watchEl(el);
      });
    }
 
    function watchEl(el) {
      if (activated.has(el)) { activate(el); return; }
      if (observed.has(el) || skipEl(el)) return;
      observed.add(el);
      pendingEls.add(el);
      io.observe(el);
      armIOCheck();
    }
 
    function handleText(t) {
      if (written.get(t) === t.nodeValue) return;
      const el = t.parentElement;
      if (!el) return;
      if (activated.has(el)) { enqueueText(t); return; }
      // бесплатно и сразу: перевод уже известен (словарь/кэш), или это скрытое меню/подсказка,
      // которая появится при наведении мыши (IntersectionObserver о ней не сообщит)
      const core = split(t.nodeValue).core;
      if (localTranslate(core) !== null || cache.has(core) || (core.length <= 40 && isHiddenEl(el))) {
        activated.add(el); activate(el); return;
      }
      watchEl(el);
    }
    function isHiddenEl(el) {
      const r = el.getBoundingClientRect();
      return r.width === 0 && r.height === 0;
    }
 
    function schedule() {
      if (timer) return;
      timer = setTimeout(pump, Math.max(60, pauseUntil - Date.now()));
    }
 
    /** Отправка батчей в Google с ограничением параллельности и обработкой сбоев. */
    function pump() {
      timer = 0;
      if (!state.pageTr) return;
      if (Date.now() < pauseUntil) { schedule(); return; }
      const free = TR_CONCURRENCY - running;
      if (free <= 0 || !waiting.size) { Ui.renderStatus(); return; }
      const cores = Array.from(waiting.keys()).filter((c) => !inflight.has(c));
      const batches = buildBatches(cores, TR_MAX_ENC).slice(0, free);
      batches.forEach(send);
      Ui.renderStatus();
    }
 
    const inflight = new Set();
 
    async function send(batch) {
      batch.forEach((c) => inflight.add(c));
      running++;
      try {
        const data = JSON.parse(await httpReq({ url: gtxUrl('zh-CN', TL, batch.map(prepForGoogle).join('\n')), timeout: 10000 }));
        const joined = parseGtx(data);
        const parts = batch.length === 1 ? [joined.trim()] : splitGtx(joined, batch.length);
        if (!parts) {
          // Google склеил строки — делим батч пополам и отправляем заново
          batch.forEach((c) => inflight.delete(c));
          running--;
          const mid = Math.ceil(batch.length / 2);
          send(batch.slice(0, mid)); send(batch.slice(mid));
          return;
        }
        const t0 = performance.now();
        batch.forEach((core, i) => {
          const tr = fixRu(parts[i] || core);
          cache.set(core, tr);
          const tasks = waiting.get(core) || [];
          waiting.delete(core);
          tasks.forEach((t) => apply(t, tr));
        });
        Perf.add('Вставка перевода текста', performance.now() - t0);
        persist();
      } catch (e) {
        stats.errors++;
        GNotice.fail(e);
        batch.forEach((c) => fails.set(c, (fails.get(c) || 0) + 1));
        batch.filter((c) => (fails.get(c) || 0) >= 3).forEach((c) => waiting.delete(c));
        pauseUntil = Date.now() + (/HTTP 429/.test(String(e)) ? 30000 : 5000);
        console.warn('[tb-rub] перевод страницы: ошибка Google', e);
      }
      batch.forEach((c) => inflight.delete(c));
      running--;
      schedule();
    }
 
    function start() {
      if (io || !document.body) return;
      document.documentElement.setAttribute('translate', 'no');   // просим браузер не переводить поверх нас
      document.documentElement.classList.add('notranslate', 'tbrub-tr');
      io = new IntersectionObserver(onIntersect, { rootMargin: (NEAR_PX / 2) + 'px 0px ' + NEAR_PX + 'px 0px' });
      scan(document.body);
      sweepTimer = setInterval(sweep, 1000);
    }
 
    function stop() {
      if (io) io.disconnect();
      io = null;
      clearInterval(sweepTimer);
      pendingEls.clear();
      activated = new WeakSet();
      observed = new WeakSet();
      waiting.clear();
      for (const el of revs) {
        el.removeAttribute('data-tbrub-rev');
        const d = el.querySelector(':scope > .tbrub-rev');
        if (d) d.remove();
      }
      revs.clear();
      revSrc = new WeakMap();
      document.documentElement.removeAttribute('translate');
      document.documentElement.classList.remove('notranslate', 'tbrub-tr');
      for (const t of touched) {
        if (t.isConnected && t.nodeValue === written.get(t)) {
          written.delete(t);                 // чтобы при повторном включении узел снова перевёлся
          t.nodeValue = original.get(t);
        }
      }
      touched.clear();
      for (const box of boxes) {
        box.removeAttribute('data-tbrub-tt');
        ['--tbrub-n', '--tbrub-lh', '--tbrub-fs', '--tbrub-c'].forEach((p) => box.style.removeProperty(p));
      }
      boxes.clear();
      boxSrc = new WeakMap();
      fight = new WeakMap();
      contested = new WeakSet();
      for (const [el, attrs] of touchedAttr) {
        for (const a in attrs) {
          if (!el.isConnected) continue;
          if (attrs[a] === null) el.removeAttribute(a); else el.setAttribute(a, attrs[a]);
        }
      }
      touchedAttr.clear();
      shrunk.forEach((el) => el.style.removeProperty('font-size'));
      shrunk.clear();
      document.querySelectorAll('[data-tbrub-ann]').forEach((el) => el.removeAttribute('data-tbrub-ann'));
      stats.done = 0;
    }
 
    return {
      start, stop, scan,
      isOwnWrite: (t) => written.get(t) === t.nodeValue,
      ioBroken: () => ioBroken,
      batch,
      /** Не отправлять новые порции перевода страницы ms миллисекунд (освобождаем канал для перевода запроса). */
      hold: (ms) => { pauseUntil = Math.max(pauseUntil, Date.now() + ms); },
      cached: (core) => cache.get(core),
      remember: (core, tr) => { cache.set(core, tr); persist(); },
      /** Исходный (китайский) текст узла, даже если мы его уже перевели. */
      origOf: (t) => (written.get(t) === t.nodeValue && original.has(t) ? original.get(t) : t.nodeValue),
      /** Перевести отзывы заново (переключили «отзыв целиком»). */
      resetReviews() {
        for (const el of revs) { el.removeAttribute('data-tbrub-rev'); const d = el.querySelector(':scope > .tbrub-rev'); if (d) d.remove(); }
        revs.clear(); revSrc = new WeakMap();
        if (io) document.querySelectorAll(REV_SEL).forEach((el) => scan(el));
      },
      status: () => ({ done: stats.done, queue: waiting.size, errors: stats.errors, active: !!io })
    };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6. УМНЫЙ ПЕРЕВОД ПОИСКА (RU/EN → 中文)
   * ══════════════════════════════════════════════════════════════════════ */
  /** Ссылки Taobao/Tmall (товары, рекламные карточки click.*.simba, поиск, магазины, главная) — в этой же вкладке.
   *  В новой вкладке оставляем только вход/выход, чат с продавцом, справку и обратную связь. */
  const MARKET_URL_RE = /^https?:\/\/(?:[\w-]+\.)*(?:taobao|tmall)\.(?:com|hk)(?:[\/?#]|$)/i;
  const KEEP_NEW_TAB_RE = /^https?:\/\/(?:login|passport|amos|wangwang|consumerservice|helpcenter|service|ihelp|rate)\.|\/logout|feedback|\/chat|webww/i;
  const sameTabUrl = (href) => MARKET_URL_RE.test(href) && !KEEP_NEW_TAB_RE.test(href);
  const SEARCH_INPUT_SEL = [
    'input#q', 'input[name="q"]', 'input[class*="search-suggest-combobox"]', '[class*="search-suggest-combobox"] input',
    'input[class*="search-combobox-input"]', 'input[class*="powerfulQuery"]'
  ].concat(MOBILE ? [                                  // мобильная версия: поле поиска — type=search / в форме поиска / «搜索» в подсказке
    'input[type="search"]', 'form[action*="search"] input[type="text"]', 'input[placeholder*="搜索"]', 'input[class*="search" i]'
  ] : []).join(',');
  const GLOBAL_BTN_SEL = '.search-suggest-button-0,.search-suggest-button-single,button.btn-search,button[class*="searchBtn--"],[data-sg-type="button"]';
  const SHOP_BTN_SEL = '.search-suggest-button-1';   // «搜本店» — поиск по магазину: отдаём Taobao с переведённым текстом
  const ANY_BTN_SEL = GLOBAL_BTN_SEL + ',' + SHOP_BTN_SEL + ',button,[type="submit"],[role="button"],[class*="search-button"],[class*="btn-search"]';
 
  const Search = (() => {
    const cache = (() => { const c = store.get('zhCache', {}); return c && typeof c === 'object' ? c : {}; })();
    let busy = false, swallowEnter = false, bypass = false;
 
    function cacheSet(key, val) {
      cache[key] = val;
      const keys = Object.keys(cache);
      if (keys.length > 300) keys.slice(0, keys.length - 300).forEach((k) => delete cache[k]);
      store.set('zhCache', cache);
    }
 
    const pendingQ = new Map();      // один и тот же текст переводится один раз (предперевод при наборе + Enter)
    function translateRun(text) {
      const key = text.toLowerCase();
      if (cache[key]) return Promise.resolve(cache[key]);
      if (pendingQ.has(key)) return pendingQ.get(key);
      const p = (async () => {
        let lastErr;
        for (let i = 0; i < 2; i++) {
          try {
            // короткий таймаут: Google отвечает за 0,1–0,7 с; зависший запрос лучше повторить, чем ждать 7 с
            const zh = parseGtx(JSON.parse(await httpReq({ url: gtxUrl('auto', 'zh-CN', text), timeout: i ? 5000 : 3000 })));
            if (!zh) throw new Error('empty translation');
            cacheSet(key, zh);
            return zh;
          } catch (e) { lastErr = e; GNotice.fail(e); }
        }
        throw lastErr;
      })();
      pendingQ.set(key, p);
      p.then(() => pendingQ.delete(key), () => pendingQ.delete(key));
      return p;
    }
    const isCached = (plan) => plan.parts.every((p) => p.keep || cache[p.text.toLowerCase()]);
 
    async function translatePlan(plan) {
      let ok = 0;
      const out = await Promise.all(plan.parts.map(async (p) => {
        if (p.keep) return p.text;
        try { const zh = cleanZh(await translateRun(p.text)); ok++; return zh; } catch (_) { return p.text; }
      }));
      if (!ok) throw new Error('translation failed');
      return out.join(' ').replace(/\s+/g, ' ').trim();
    }
 
    function navigateGlobal(q, forceTab) {
      const host = location.hostname;
      let tab = forceTab || '';
      if (tab) { /* выбранная вкладка поиска (например, «Tmall») */ } else if (/(^|\.)tmall\.com$/.test(host)) tab = 'mall';
      else if (host === 's.taobao.com') tab = new URLSearchParams(location.search).get('tab') || '';
      location.assign('https://s.taobao.com/search?q=' + encodeURIComponent(q) +
        '&commend=all&search_type=item&ie=utf8' + (tab ? '&tab=' + encodeURIComponent(tab) : ''));
    }
 
    function setNativeValue(input, v) {
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(input, v); else input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
 
    /** Поиск по магазину / нестандартная вкладка: подставляем китайский текст и повторяем действие Taobao. */
    function nativeSubmit(input, zh, trigger) {
      setNativeValue(input, zh);
      bypass = true;
      try {
        if (trigger && trigger.isConnected && trigger.tagName !== 'INPUT') trigger.click();
        else {
          const f = input.form || input.closest('form');
          if (f && f.requestSubmit) f.requestSubmit();
          else if (f) f.submit();
        }
      } finally { setTimeout(() => { bypass = false; }, 0); }
    }
 
    /** Мобильная версия: у поля поиска есть форма или кнопка — повторяем действие страницы с китайским текстом
     *  (так работает и кнопка «Поиск» на клавиатуре телефона); иначе — мобильная выдача Taobao. */
    function mobileSubmit(input, q, trigger) {
      const before = location.href;
      let gone = false;
      const mark = () => { gone = true; };
      window.addEventListener('pagehide', mark, { once: true });
      window.addEventListener('beforeunload', mark, { once: true });
      const own = !!(input.form || input.closest('form') || (trigger && trigger.isConnected && trigger.tagName !== 'INPUT'));
      if (own) nativeSubmit(input, q, trigger);
      // страница не ушла на выдачу сама (поиск у неё на другом событии) — открываем мобильную выдачу Taobao
      setTimeout(() => { if (!gone && location.href === before) location.assign('https://s.m.taobao.com/h5?q=' + encodeURIComponent(q)); }, own ? 1500 : 0);
    }

    function isSearchInput(el) {
      return !!el && el.tagName === 'INPUT' && !/^(hidden|checkbox|radio|button|submit|file)$/i.test(el.type) && el.matches(SEARCH_INPUT_SEL);
    }
 
    function findInputNear(btn) {
      for (let a = btn, i = 0; a && i < 6; a = a.parentElement, i++) {
        const list = a.querySelectorAll ? Array.from(a.querySelectorAll(SEARCH_INPUT_SEL)).filter(isSearchInput) : [];
        const vis = list.find((x) => x.offsetParent !== null) || list[0];
        if (vis) return vis;
      }
      return null;
    }
 
    function looksLikeSearchButton(el) {
      if (el.matches(GLOBAL_BTN_SEL) || el.matches(SHOP_BTN_SEL)) return true;
      const meta = [typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label') || '', el.getAttribute('title') || ''].join(' ');
      if (/clear|close|reset|delete|cancel|history|image|img|camera|photo|upload|voice|mic|拍照|图片|清除|删除/i.test(meta)) return false;
      if (el.type === 'submit') return true;
      if (/search|submit|搜索/i.test(meta)) return true;
      return /^(搜索|search|поиск|найти)$/i.test((el.textContent || '').trim());
    }
 
    /** Нужен ли «родной» путь Taobao (поиск по магазину, вкладка «店铺» и т.п.). */
    function selectedTab(input) {
      const box = input.closest('.search-suggest,#J_Search,#J_TSearchForm');
      const tab = box && box.querySelector('.search-suggest-tabs-tab.selected');
      return (tab && tab.getAttribute('data-value')) || '';
    }
    function needsNative(input, trigger) {
      if (trigger && trigger.closest && trigger.closest(SHOP_BTN_SEL)) return true;
      const val = selectedTab(input);
      return !!(val && val !== 'item' && val !== 'tmall');   // «Tmall» — тот же глобальный поиск с вкладкой mall
    }
 
    function intercept(e, input, trigger) {
      if (bypass || !state.searchTr) return false;
      const value = (input.value || '').trim();
      if (!value) return false;
      const plan = buildPlan(value);
      if (!plan.runs) return false;            // переводить нечего — штатный поиск
      e.preventDefault();
      e.stopImmediatePropagation();
      if (busy) return true;
      busy = true;
      const prevCursor = input.style.cursor;
      input.style.cursor = 'progress';
      const native = needsNative(input, trigger);
      const t0 = performance.now();
      const cached = isCached(plan);
      if (!cached) {
        toast('🔎 Перевожу запрос…', 8000, input);
        Translator.hold(8000);                         // перевод страницы подождёт — запрос важнее, страница всё равно сменится
      }
      translatePlan(plan)
        .finally(() => {
          const ms = Math.round(performance.now() - t0);
          console.info('[tb-rub] поиск: перевод запроса ' + ms + ' мс' + (cached ? ' (из кэша)' : ''));
          store.set('lastSearchT', { at: Date.now(), tr: ms, cached });   // следующая страница допишет время загрузки
        })
        .catch((err) => { console.warn('[tb-rub] перевод запроса не удался:', err); return null; })
        .then((zh) => {
          busy = false;
          input.style.cursor = prevCursor;
          const q = zh || value;
          toast(zh ? '🔎 ' + value + ' → ' + zh : 'Перевод не удался, ищу как есть: ' + value, 4000, input);
          if (native) nativeSubmit(input, q, trigger);
          else if (MOBILE) mobileSubmit(input, q, trigger);
          else navigateGlobal(q, selectedTab(input) === 'tmall' ? 'mall' : '');
        });
      return true;
    }
 
    function install() {
      const target = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
        const t = target(e);
        if (isSearchInput(t) && intercept(e, t, null)) swallowEnter = true;
      }, true);
      ['keypress', 'keyup'].forEach((type) => {
        document.addEventListener(type, (e) => {
          if (!swallowEnter || e.key !== 'Enter') return;
          e.stopImmediatePropagation(); e.preventDefault();
          if (type === 'keyup') swallowEnter = false;
        }, true);
      });
      document.addEventListener('submit', (e) => {
        const f = e.target;
        const inp = f && f.querySelector && f.querySelector(SEARCH_INPUT_SEL);
        // форма поиска Tmall/Taobao открывает выдачу в новой вкладке (target=_blank) — открываем в этой же
        if (state.sameTab && f && f.getAttribute && f.getAttribute('target') === '_blank' && sameTabUrl(f.action || '')) f.setAttribute('target', '_self');
        if (inp && isSearchInput(inp)) intercept(e, inp, null);
      }, true);
      // переведённые вкладки поиска («Tmall ˅», «Магазины») шире китайских и наезжают на начало строки ввода —
      // сдвигаем начало текста ровно настолько, насколько вкладки перекрывают поле
      const fixIndent = (inp) => {
        const box = inp.closest('.search-suggest,#J_Search,#J_TSearchForm');
        const tabs = box && box.querySelector('.search-suggest-tabs');
        if (!tabs) return;
        const a = tabs.getBoundingClientRect(), b = inp.getBoundingClientRect();
        if (!a.width || !b.width || a.left > b.left || a.bottom < b.top || a.top > b.bottom) return;
        const base = parseFloat(inp.dataset.tbrubIndent || getComputedStyle(inp).textIndent) || 0;
        if (!inp.dataset.tbrubIndent) inp.dataset.tbrubIndent = String(base);
        const need = Math.ceil(a.right - b.left + 8);
        inp.style.setProperty('text-indent', Math.max(base, need) + 'px', 'important');
      };
      document.addEventListener('focusin', (e) => { const t = target(e); if (isSearchInput(t)) fixIndent(t); }, true);
      // предперевод при наборе: пауза 250 мс — переводим заранее, к нажатию Enter перевод уже в кэше
      let preT = 0;
      document.addEventListener('input', (e) => {
        const t = target(e);
        if (!state.searchTr || !isSearchInput(t)) return;
        clearTimeout(preT);
        preT = setTimeout(() => {
          const v = (t.value || '').trim();
          if (v.length < 2) return;
          const plan = buildPlan(v);
          if (plan.runs && !isCached(plan)) translatePlan(plan).catch(() => {});
        }, 250);
      }, true);
      document.addEventListener('input', (e) => { const t = target(e); if (isSearchInput(t) && t.value.length < 3) fixIndent(t); }, true);
      document.addEventListener('click', (e) => {
        const t = target(e);
        const btn = t && t.closest && t.closest(ANY_BTN_SEL);
        if (!btn || btn.closest('#tbrub-root') || !looksLikeSearchButton(btn)) return;
        const inp = findInputNear(btn);
        if (inp) intercept(e, inp, btn);
      }, true);
    }
 
    return { install };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6½. ПЕРЕВОД ТЕКСТА НА КАРТИНКАХ
   *  Кнопки поверх картинки при наведении: открывают оригинал в полном размере в Google Lens
   *  (вкладка «Перевести») или в Яндекс Картинках (блок «Текст на картинке» → перевод).
   * ══════════════════════════════════════════════════════════════════════ */
  const ImgTr = (() => {
    const MIN_SIDE = 140;
    // Миниатюры-карточки (ссылка на товар): наша кнопка над ними уводит курсор с карточки, Taobao на каждый
    // повторный заход мыши шлёт запрос (mtop) — поэтому на карточках кнопок нет, только на фото товара/описания.
    const CARD_LINK_SEL = 'a[href*="item.taobao.com"],a[href*="detail.tmall.com"],a[href*="item.htm"],a[href*="click.simba"],' +
      'a[href*="detail.taobao.com"],a[href*="world.taobao.com/item"],[class*="doubleCard"],[class*="Card--"]';
    let wrap = null, cur = null, last = 0, btnHere = null, shownAt = 0;
 
    /** Полноразмерный URL: alicdn-миниатюры имеют хвост вида «.jpg_760x760q30.jpg_.webp». */
    function fullUrl(src) {
      let u = src || '';
      if (!u || /^(data|blob):/i.test(u)) return null;
      if (u.startsWith('//')) u = 'https:' + u;
      u = u.replace(/(\.(?:jpe?g|png|gif|webp))_[^/?#]*$/i, '$1');
      return /^https?:\/\//i.test(u) ? u : null;
    }
 
    /** Реально показанный адрес; при сбое srcset — атрибут src или ленивый data-src. */
    // Ленивые картинки Taobao: в src заглушка (s.gif), настоящий адрес — в data-src, грузится только при прокрутке
    const PLACEHOLDER_RE = /^data:|\/s\.gif(?:$|[?#])|spaceball|\/1x1\.|blank\.(?:gif|png)/i;
    const lazySrc = (el) => el.getAttribute('data-src') || el.getAttribute('data-ks-lazyload') || el.getAttribute('data-lazy-src') || '';
    const isPlaceholder = (el) => { const c = el.currentSrc || el.getAttribute('src') || ''; return !c || PLACEHOLDER_RE.test(c); };
    function imgSrc(el) {
      const c = el.currentSrc;
      if (c && /^(https?:)?\/\//i.test(c) && !PLACEHOLDER_RE.test(c)) return c;
      const lz = lazySrc(el);
      if (lz && !PLACEHOLDER_RE.test(lz)) return lz;
      return el.getAttribute('src') || el.src || '';
    }
 
    /** Подходит ли картинка для перевода: не миниатюра-карточка, достаточно крупная, с нормальным адресом. */
    function eligible(el, minW, minH) {
      if (!el || el.tagName !== 'IMG' || el.closest(CARD_LINK_SEL)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= (minW || MIN_SIDE) && r.height >= (minH || MIN_SIDE) && !!fullUrl(imgSrc(el));
    }
 
    function pick(x, y) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el.closest && el.closest('#tbrub-imgbtn,#tbrub-root')) return 'self';
        if (el.tagName === 'IMG') return eligible(el) ? el : null;
      }
      return null;
    }
 
    /** Внешние сервисы: открывают фото по адресу в новой вкладке. Значки — favicon самих сервисов. */
    const SERVICES = [
      { kind: 'google', name: 'Google Lens', title: 'Google Lens — перевести текст на фото (вкладка «Перевести»)', host: 'lens.google.com', alt: 'G',
        url: (u) => 'https://lens.google.com/uploadbyurl?url=' + u + '&hl=ru' },
      { kind: 'yandex', name: 'Яндекс', title: 'Яндекс Картинки — «Текст на картинке» → перевод', host: 'yandex.ru', alt: 'Я',
        url: (u) => 'https://yandex.ru/images/search?rpt=imageview&url=' + u },
      { kind: '1688', name: '1688', title: '1688 — найти этот товар у фабрики (поиск по фото, оптовые цены)', host: 'www.1688.com', alt: '1688',
        url: (u) => 'https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=' + u }
    ];
    function open(kind) {
      if (!cur) return;
      if (kind === 'here') { ImgOcr.toggle(cur); refresh(); return; }
      const s = SERVICES.find((x) => x.kind === kind);
      if (!s) return;
      window.open(s.url(encodeURIComponent(fullUrl(imgSrc(cur)))), '_blank', 'noopener');
    }
 
    function ensure() {
      if (wrap) return wrap;
      wrap = document.createElement('div');
      wrap.id = 'tbrub-imgbtn';
      wrap.className = 'notranslate';
      wrap.setAttribute('translate', 'no');
      const mkb = (text, title, kind, favHost) => {
        const b = document.createElement('button');
        b.type = 'button'; b.title = title;
        if (favHost) {
          const im = document.createElement('img');
          im.alt = text;
          im.referrerPolicy = 'no-referrer';
          im.src = 'https://www.google.com/s2/favicons?sz=64&domain=' + favHost;
          im.addEventListener('error', () => {               // значок не загрузился — буква сервиса
            const t = document.createElement('span');
            t.textContent = text;
            if (text.length > 2) t.style.fontSize = '9px';
            im.replaceWith(t);
          }, { once: true });
          b.appendChild(im);
        } else b.textContent = text;
        // перехватываем раньше страницы: под картинкой часто ссылка на товар или зум галереи
        ['pointerdown', 'mousedown', 'mouseup'].forEach((t) => b.addEventListener(t, (e) => { e.stopPropagation(); }, true));
        b.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          if (MOBILE && performance.now() - shownAt < 450) return;   // «призрачный» клик от того же долгого нажатия
          open(kind);
        }, true);
        return b;
      };
      btnHere = mkb('文', 'Перевести текст прямо на фото (распознавание в браузере)', 'here');
      btnHere.classList.add('here');
      wrap.append(btnHere, ...SERVICES.map((s) => mkb(s.alt, s.title, s.kind, s.host)));
      document.body.appendChild(wrap);
      return wrap;
    }
 
    function refresh() {
      if (MOBILE) MobImg.refresh();
      if (!btnHere) return;
      const st = !cur ? 'idle' : ImgOcr.busy(cur) ? 'busy' : ImgOcr.has(cur) ? 'shown' : 'idle';
      btnHere.textContent = st === 'busy' ? '⏳' : st === 'shown' ? '↩' : '文';
      btnHere.title = st === 'busy' ? 'Перевожу текст на фото…' : st === 'shown' ? 'Показать оригинал' : 'Перевести текст прямо на фото (распознавание в браузере)';
    }
 
    function place(img) {
      const w = ensure();
      const r = img.getBoundingClientRect();
      cur = img;
      refresh();
      // столбик значков у левого края фото (справа вверху у Taobao свои значки); на невысоком фото — строкой
      w.classList.toggle('row', r.height < 4 * 36 + 16);
      w.style.display = 'flex';
      w.style.left = Math.max(6, Math.min(window.innerWidth - w.offsetWidth - 6, r.left + 8)) + 'px';
      w.style.top = Math.max(6, r.top + 8) + 'px';
      cur = img;
    }
 
    function hide() { if (wrap) wrap.style.display = 'none'; cur = null; }
 
    function onMove(e) {
      if (!state.imgTr) return;
      const now = performance.now();
      if (now - last < 80) return;
      last = now;
      const t = pick(e.clientX, e.clientY);
      if (t === 'self') return;
      if (t) place(t); else hide();
    }
 
    function install() {
      window.addEventListener('scroll', hide, { passive: true, capture: true });
      if (MOBILE) {
        // на телефоне наведения нет (касание порождает «mousemove»): столбик сервисов — по долгому нажатию на значок «文»,
        // прячется при касании мимо него
        document.addEventListener('pointerdown', (e) => { if (wrap && !(e.target.closest && e.target.closest('#tbrub-imgbtn'))) hide(); }, true);
        return;
      }
      document.addEventListener('mousemove', onMove, { passive: true, capture: true });
      document.addEventListener('mouseleave', hide);
    }
    /** Сервисы у конкретного фото (телефон: долгое нажатие на значок «文») — строкой справа от значка,
     *  без своего «文» (перевод — сам значок). */
    function showFor(img) {
      if (!img || !img.isConnected) return;
      place(img);
      const r = img.getBoundingClientRect();
      btnHere.style.display = 'none';
      wrap.classList.add('row');
      wrap.style.left = Math.max(6, Math.min(window.innerWidth - wrap.offsetWidth - 6, Math.max(r.left, 0) + 52)) + 'px';
      wrap.style.top = Math.max(6, r.top + 8) + 'px';
      shownAt = performance.now();
    }
 
    /** Миниатюра товара (в поиске, ленте) — внутри ссылки на товар. */
    // вне карточки товара любая картинка-ссылка (плитки акций на главной Tmall/Taobao ведут на страницы акций, а не на товар)
    const isThumb = (el) => !!el.closest(CARD_LINK_SEL) || (!isItemPage() && !!el.closest('a[href]'));
    return { install, hide, showFor, fullUrl, imgSrc, refresh, eligible, isThumb, lazySrc, isPlaceholder };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6⅝. ДВИЖКИ РАСПОЗНАВАНИЯ ТЕКСТА НА КАРТИНКАХ (без ключей — прямо в браузере)
   *  PaddleOCR (PP-OCRv4, ONNX Runtime Web/WebAssembly) и Tesseract.js (chi_sim).
   *  Библиотеки и модели качаются с CDN один раз (≈27 МБ / ≈5 МБ) и хранятся в IndexedDB сайта.
   *  Код библиотек грузится только при первом использовании, на остальных страницах ничего не весит.
   * ══════════════════════════════════════════════════════════════════════ */
  const CDN_BASES = ['https://cdn.jsdelivr.net/npm/', 'https://fastly.jsdelivr.net/npm/', 'https://unpkg.com/'];
  const ORT_PKG = 'onnxruntime-web@1.18.0/dist/';
  const PADDLE_PKG = '@gutenye/ocr-models@1.4.2/assets/';
  const TESS_PKG = 'tesseract.js@5.1.1/dist/tesseract.min.js';
  const ENGINE_NAMES = { paddle: 'PaddleOCR', tesseract: 'Tesseract', vision: 'Google Vision' };
 
  /* ── Процессор: сколько потоков распознавания разумно запускать ──
   * Браузер сообщает только число логических потоков (navigator.hardwareConcurrency). Физические ядра он скрывает,
   * а микро-замер в браузере их не различает: Windows сажает потоки парами на гиперпотоки одного блока ядер
   * (проверено на 12 ядрах/24 потоках — замер показал «24 ядра»). Поэтому считаем, как у подавляющего большинства
   * x86-процессоров: физических ядер = половина потоков (у 2-поточных — 1). Реальную скорость показываем по факту. */
  const CpuInfo = (() => {
    const L = Math.max(1, navigator.hardwareConcurrency || 4);
    const P = L >= 4 ? Math.round(L / 2) : Math.max(1, Math.floor(L / 2) || 1);
    const get = () => ({ L, P });

    /** Модель по замеру на 12 ядрах/24 потоках: КПД потока 2 → 89%, 4 → 79%, 6 → 73%, 8 → 69%, 12 → 68%;
     *  гиперпоток сверх физических ядер даёт ≈ 0,45 обычного. thr — скорость в «одиночных потоках». */
    function model(k, P) {
      const phys = Math.min(k, P), ht = Math.max(0, k - P);
      const e = 0.66 + 0.34 / Math.pow(Math.max(1, phys), 0.9);
      const thr = phys * e + ht * 0.45 * e;
      return { thr, eff: thr / Math.max(1, k) };
    }

    /** Шкала ползунка: оптимум (½ физ. ядер), граница физ. ядер, максимум (все потоки − 1, с учётом памяти). */
    function plan() {
      const c = get();
      const memGB = navigator.deviceMemory || 8;
      const memCap = Math.max(1, Math.floor((memGB * 1024 * 0.2) / 170));    // не больше ~20% памяти (≈170 МБ на поток)
      // телефон: ядра в основном энергоэффективные, память делят все вкладки — оптимум 1 поток, максимум 2
      const max = Math.max(1, Math.min(c.L - 1, memCap, MOBILE ? 2 : 64));
      const opt = MOBILE ? 1 : Math.max(1, Math.min(max, Math.round(c.P / 2)));
      const phys = Math.max(opt, Math.min(max, c.P - 1));
      const k = state.ocrThreads > 0 ? Math.min(state.ocrThreads, max) : opt;
      return { k, opt, phys, max, L: c.L, P: c.P };
    }

    return { get, model, plan };
  })();

  const OcrEngines = (() => {
    const status = { paddle: '', tesseract: '' };
    const debug = {};                                  // последние сырые результаты распознавания (для отладки)
    let quiet = false;                                 // автоперевод в фоне: никаких всплывающих сообщений
    let progress = '';                                 // что сейчас грузится (для строки состояния в панели)
    let notifyT = 0;
    const notify = () => { if (!notifyT) notifyT = setTimeout(() => { notifyT = 0; Ui.render(); }, 400); };
    const say = (t, ms) => { if (!quiet) toast(t, ms); };
    const setQuiet = (q) => { quiet = !!q; };     // '' — не загружался, 'ok', 'loading' или текст ошибки
    const mb = (n) => (n / 1048576).toFixed(1);
 
    // ── IndexedDB: кэш библиотек и моделей ──
    let dbp = null;
    function idb() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open('tbrub-ocr', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('files');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        dbp.catch(() => { dbp = null; });
      }
      return dbp;
    }
    async function idbGet(k) {
      try {
        const db = await idb();
        return await new Promise((res) => {
          const q = db.transaction('files').objectStore('files').get(k);
          q.onsuccess = () => res(q.result || null);
          q.onerror = () => res(null);
        });
      } catch (_) { return null; }
    }
    async function idbPut(k, v) {
      try {
        const db = await idb();
        await new Promise((res) => {
          const tx = db.transaction('files', 'readwrite');
          tx.objectStore('files').put(v, k);
          tx.objectStore('files').delete('__sizes');   // размер моделей пересчитается
          tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
        });
        modelBytes = -1;
      } catch (_) { /* кэш не обязателен */ }
    }
    /** Сколько места занимают скачанные библиотеки и модели на этом сайте (для лимита кэша). */
    let modelBytes = -1;
    async function modelsSize() {
      if (modelBytes >= 0) return modelBytes;
      const db = await idb();
      const sizes = await new Promise((res) => {
        const r = db.transaction('files').objectStore('files').get('__sizes');
        r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
      });
      if (sizes && sizes.v === 1) { modelBytes = sizes.total; return modelBytes; }
      // разовый подсчёт по самим файлам (у тех, кто скачал модели в прошлых версиях)
      let total = 0;
      await new Promise((res) => {
        const c = db.transaction('files').objectStore('files').openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) { res(); return; }
          const v = cur.value;
          if (cur.key !== '__sizes') total += v && v.byteLength !== undefined ? v.byteLength : String(v || '').length;
          cur.continue();
        };
        c.onerror = () => res();
      });
      try { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ v: 1, total }, '__sizes'); } catch (_) { /* не важно */ }
      modelBytes = total;
      return total;
    }
    /** «Удалить модели»: скачаются заново при следующем распознавании. */
    async function deleteModels() {
      const db = await idb();
      await new Promise((res) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').clear();
        tx.oncomplete = res; tx.onerror = res; tx.onabort = res;
      });
      modelBytes = 0;
    }
 
    function get(url, type, onProgress) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest !== 'function') {
          fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return type === 'text' ? r.text() : r.arrayBuffer(); })
            .then(resolve, reject);
          return;
        }
        GM_xmlhttpRequest({
          method: 'GET', url, responseType: type === 'text' ? 'text' : 'arraybuffer', timeout: 240000,
          onprogress: (e) => { if (onProgress && e && e.loaded) onProgress(e.loaded, e.total || 0); },
          onload: (r) => (r.status >= 200 && r.status < 300
            ? resolve(type === 'text' ? r.responseText : r.response)
            : reject(new Error('HTTP ' + r.status + ' ' + url))),
          onerror: () => reject(new Error('нет связи с ' + url.split('/')[2])),
          ontimeout: () => reject(new Error('таймаут ' + url.split('/')[2]))
        });
      });
    }
 
    let okBase = CDN_BASES[0];                         // зеркало, которое последним ответило
 
    /** Файл пакета npm с CDN (зеркала по очереди) с кэшем в IndexedDB. */
    async function cdnFile(path, type, label, silent) {
      const key = 'v1:' + path;
      const cached = await idbGet(key);
      if (cached) return cached;
      let err = null;
      for (const base of CDN_BASES) {
        try {
          let lastT = 0;
          const data = await get(base + path, type, (l, t) => {
            const now = Date.now();
            if (now - lastT < 300) return;
            lastT = now;
            progress = 'загрузка «' + label + '»: ' + mb(l) + (t ? ' из ' + mb(t) : '') + ' МБ';
            notify();
            if (!silent) say('⏳ Загрузка (один раз): ' + label + ' — ' + mb(l) + (t ? ' из ' + mb(t) : '') + ' МБ', 60000);
          });
          if (type === 'text' ? !data || data.length < 20 : !data || data.byteLength < 1000) throw new Error('пустой ответ CDN');
          idbPut(key, data);
          okBase = base;
          return data;
        } catch (e) { err = e; console.warn('[tb-rub] OCR: не скачался ' + base + path, e); }
      }
      throw err || new Error('не удалось скачать ' + label);
    }
 
    /** Выполняет UMD-библиотеку в песочнице скрипта (AMD страницы не мешает) и возвращает её экспорт. */
    function evalLib(code, name) {
      const module = { exports: {} };
      // eslint-disable-next-line no-new-func
      // сборки вида `var ort = (()=>{…})()` внутри функции объявляют локальную переменную — возвращаем её явно
      const fn = new Function('module', 'exports', 'define',
        code + '\n;return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined;\n//# sourceURL=tbrub-' + name + '.js');
      const ret = fn.call(window, module, module.exports, undefined);
      if (ret && (ret.InferenceSession || ret.createWorker)) return ret;
      const ex = module.exports;
      if (ex && (ex.InferenceSession || ex.createWorker)) return ex;
      if (ex && ex[name]) return ex[name];
      return (typeof self !== 'undefined' && self[name]) || window[name] || null;
    }
 
    const whiteCanvas = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, w, h);
      return { c, cx };
    };
 
    // ── PaddleOCR (PP-OCRv4: детектор DBNet + распознаватель CRNN/CTC) ──
    let paddleP = null;
    function paddleInit() {
      if (paddleP) return paddleP;
      status.paddle = 'loading';
      paddleP = (async () => {
        const lib = await cdnFile(ORT_PKG + 'ort.wasm-core.min.js', 'text', 'ONNX Runtime');
        const wasm = await cdnFile(ORT_PKG + 'ort-wasm-simd.wasm', 'bin', 'ONNX Runtime (wasm)');
        const det = await cdnFile(PADDLE_PKG + 'ch_PP-OCRv4_det_infer.onnx', 'bin', 'модель поиска текста');
        const rec = await cdnFile(PADDLE_PKG + 'ch_PP-OCRv4_rec_infer.onnx', 'bin', 'модель иероглифов');
        const keys = await cdnFile(PADDLE_PKG + 'ppocr_keys_v1.txt', 'text', 'словарь');
        say('⏳ PaddleOCR: запуск…', 60000);
        let lastErr = null;
        // wasm: сначала из нашего кэша (blob:), при отказе — напрямую с CDN (новый экземпляр библиотеки)
        for (const mode of ['blob', 'cdn']) {
          try {
            const ort = evalLib(lib, 'ort');
            if (!ort || !ort.InferenceSession) throw new Error('ONNX Runtime не инициализировался');
            ort.env.wasm.numThreads = 1;              // без воркеров и SharedArrayBuffer
            ort.env.wasm.proxy = false;
            ort.env.wasm.simd = true;
            if (mode === 'blob') {
              const u = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
              ort.env.wasm.wasmPaths = { 'ort-wasm-simd.wasm': u, 'ort-wasm.wasm': u };
            } else ort.env.wasm.wasmPaths = okBase + ORT_PKG;
            const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
            const sDet = await ort.InferenceSession.create(new Uint8Array(det), opt);
            const sRec = await ort.InferenceSession.create(new Uint8Array(rec), opt);
            status.paddle = 'ok';
            return { ort, sDet, sRec, keys, chars: null };
          } catch (e) { lastErr = e; console.warn('[tb-rub] PaddleOCR: запуск (' + mode + ') не удался', e); }
        }
        throw lastErr;
      })();
      paddleP.catch((e) => { paddleP = null; status.paddle = String((e && e.message) || e).slice(0, 140); notify(); });
      return paddleP;
    }
 
    async function paddleDetect(P, src, W, H) {
      const lines = [];
      const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];   // порядок каналов BGR, как в PaddleOCR
      for (const t of tilesFor(W, H)) {
        const tw = t.x1 - t.x0, th = t.y1 - t.y0;
        const scale = Math.min(1, 960 / Math.max(tw, th));
        const w = Math.max(32, Math.round((tw * scale) / 32) * 32), h = Math.max(32, Math.round((th * scale) / 32) * 32);
        const { cx } = whiteCanvas(w, h);
        cx.drawImage(src, t.x0, t.y0, tw, th, 0, 0, w, h);
        const px = cx.getImageData(0, 0, w, h).data;
        const n = w * h, f = new Float32Array(3 * n);
        for (let i = 0; i < n; i++) {
          const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
          f[i] = (b - mean[0]) / std[0];
          f[n + i] = (g - mean[1]) / std[1];
          f[2 * n + i] = (r - mean[2]) / std[2];
        }
        const out = await P.sDet.run({ [P.sDet.inputNames[0]]: new P.ort.Tensor('float32', f, [1, 3, h, w]) });
        const o = out[P.sDet.outputNames[0]];
        const oh = o.dims[o.dims.length - 2], ow = o.dims[o.dims.length - 1];
        const sx = tw / ow, sy = th / oh;
        for (const b of detBoxes(o.data, ow, oh)) {
          const y0 = t.y0 + b.y0 * sy, y1 = t.y0 + b.y1 * sy, my = (y0 + y1) / 2;
          const x0 = t.x0 + b.x0 * sx, x1 = t.x0 + b.x1 * sx, mx = (x0 + x1) / 2;
          if (my < t.k0 || my >= t.k1 || mx < t.kx0 || mx >= t.kx1) continue;   // строку из перекрытия считает одна полоса
          lines.push({ x0, y0, x1, y1 });
        }
      }
      return lines;
    }
 
    /** Строка → картинка 48px высотой (вертикальную строку поворачиваем). */
    function lineImage(src, L) {
      const w = L.x1 - L.x0, h = L.y1 - L.y0;
      const vertical = h >= w * 1.5;
      const RH = 48;
      const RW = Math.max(16, Math.min(1600, Math.ceil((RH * (vertical ? h : w)) / (vertical ? w : h))));
      const { cx } = whiteCanvas(RW, RH);
      if (vertical) { cx.translate(0, RH); cx.rotate(-Math.PI / 2); cx.drawImage(src, L.x0, L.y0, w, h, 0, 0, RH, RW); }
      else cx.drawImage(src, L.x0, L.y0, w, h, 0, 0, RW, RH);
      return { RW, px: cx.getImageData(0, 0, RW, RH).data };
    }

    /** Распознавание строк — по одной, без пачек. Пачка требует «добивки» нулями до самой длинной строки:
     *  замер на 23 фото Taobao — 58% лишней работы, по одной строке на 38% быстрее и точнее (无主灯, 妆, 品监章). */
    async function paddleRecLines(P, src, boxes) {
      const RH = 48;
      const res = new Array(boxes.length);
      let lastYield = performance.now();
      for (let id = 0; id < boxes.length; id++) {
        const { RW, px } = lineImage(src, boxes[id]);
        const plane = RH * RW, f = new Float32Array(3 * plane);
        for (let i = 0, q = 0; i < plane; i++, q += 4) {             // RGBA → BGR, нормировка в [-1, 1]
          f[i] = px[q + 2] / 127.5 - 1;
          f[plane + i] = px[q + 1] / 127.5 - 1;
          f[2 * plane + i] = px[q] / 127.5 - 1;
        }
        const out = await P.sRec.run({ [P.sRec.inputNames[0]]: new P.ort.Tensor('float32', f, [1, 3, RH, RW]) });
        const o = out[P.sRec.outputNames[0]];
        const T = o.dims[1], C = o.dims[2];
        if (!P.chars || P.chars.length < C) P.chars = ctcChars(P.keys, C);
        res[id] = ctcDecode(o.data, T, C, P.chars);
        if (performance.now() - lastYield > 40) {     // основной поток (запасной путь без воркеров): отдаём кадр странице
          await new Promise((r) => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }
      return res;
    }

    /* ── Пул фоновых потоков (Web Worker) для PaddleOCR ──
     * Распознавание не блокирует страницу; несколько фото — параллельно на разных ядрах.
     * Потоки поднимаются по мере надобности (не больше, чем разрешено ползунком «Нагрузка на процессор»),
     * через 60 с простоя закрываются — память (~150 МБ на поток) возвращается системе; повторный запуск ~1 с.
     * По желанию — ещё один поток на видеокарте (WebGPU): то же качество, процессор почти не тратится.
     * Код потока собирается из тех же функций, что и основной путь (toString), плюс OffscreenCanvas вместо canvas. */
    const Pool = (() => {
      const IDLE_MS = 60000;
      let failed = false, gpuFailed = '', seq = 0, idleT = 0, srcUrl = null, sleeping = false;
      let assets = null, assetsP = null, gpuAssets = null, gpuAssetsP = null;
      const workers = [];          // { w, gpu, ready, busy, dead, mem }
      const pending = new Map();   // id → { res, rej, x }
      const waiters = [];          // задания, ждущие свободный поток
      const speed = { cpu: 0, gpu: 0, n: 0 };        // среднее время на фото в потоке, мс (скользящее)

      function source() {
        const fns = [tilesFor, detBoxes, ctcDecode, ctcChars, paddleDetect, lineImage, paddleRecLines].map(String).join('\n');
        return [
          // память wasm (для панели): перехватываем создание WebAssembly.Memory
          'const _M = WebAssembly.Memory, mems = [];',
          'WebAssembly.Memory = new Proxy(_M, { construct(t, a) { const m = new t(...a); mems.push(m); return m; } });',
          'for (const k of ["instantiate", "instantiateStreaming"]) { const f = WebAssembly[k]; if (f) WebAssembly[k] = async function (...a) {',
          '  const r = await f.apply(this, a); const ex = (r.instance || r).exports || {}; for (const n in ex) if (ex[n] instanceof _M) mems.push(ex[n]); return r; }; }',
          'const memMB = () => Math.round(mems.reduce((s, m) => s + m.buffer.byteLength, 0) / 1048576);',
          // ONNX Runtime 1.18 спрашивает у видеокарты requestAdapterInfo(), которого в новом Chrome нет (есть adapter.info)
          'if (self.GPUAdapter && !GPUAdapter.prototype.requestAdapterInfo) GPUAdapter.prototype.requestAdapterInfo = function () { return Promise.resolve(this.info || {}); };',
          'const whiteCanvas = (w, h) => { const c = new OffscreenCanvas(w, h); const cx = c.getContext("2d", { willReadFrequently: true });',
          '  cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); return { c, cx }; };',
          fns,
          'let P = null;',
          'async function init(d) {',
          '  const module = { exports: {} };',
          '  const ort = new Function("module", "exports", "define", d.lib + "\\n;return typeof ort !== \'undefined\' ? ort : undefined;")(module, module.exports, undefined) || module.exports;',
          '  ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.simd = true;',
          '  if (d.gpu && ort.env.webgpu) ort.env.webgpu.powerPreference = "high-performance";',   // в ноутбуке — дискретная, если Chrome позволит
          '  const u = URL.createObjectURL(new Blob([d.wasm], { type: "application/wasm" }));',
          '  ort.env.wasm.wasmPaths = { "ort-wasm-simd.wasm": u, "ort-wasm.wasm": u, "ort-wasm-simd.jsep.wasm": u };',
          '  const opt = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };',
          // поток видеокарты: и поиск строк, и чтение — на GPU (замер: та же скорость и те же строки, процессор свободен);
          // если поиск строк на GPU не запустился — он остаётся на процессоре
          '  const gpu = { executionProviders: ["webgpu"], graphOptimizationLevel: "all" };',
          '  const sRec = await ort.InferenceSession.create(new Uint8Array(d.rec), d.gpu ? gpu : opt);',
          '  let sDet = null;',
          '  if (d.gpu) { try { sDet = await ort.InferenceSession.create(new Uint8Array(d.det), gpu); } catch (e) { sDet = null; } }',
          '  if (!sDet) sDet = await ort.InferenceSession.create(new Uint8Array(d.det), opt);',
          '  P = { ort, sDet, sRec, keys: d.keys, chars: null };',
          '}',
          'async function run(d) {',
          '  const t0 = performance.now();',
          '  const src = d.bmp, W = d.W, H = d.H;',
          '  let boxes = await paddleDetect(P, src, W, H);',
          // миниатюры: строки, которые на экране мельче ~9px, не распознаём — их всё равно не прочесть
          '  if (d.minSide > 0) boxes = boxes.filter((b) => Math.min(b.x1 - b.x0, b.y1 - b.y0) >= d.minSide);',
          '  const recs = await paddleRecLines(P, src, boxes);',
          '  if (src.close) src.close();',
          '  return { ms: performance.now() - t0, mem: memMB(),',
          '    lines: boxes.map((b, i) => ({ text: recs[i].text, score: recs[i].score, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })) };',
          '}',
          'onmessage = async (e) => { const d = e.data;',
          '  try { if (d.type === "init") { await init(d); postMessage({ id: d.id, ok: true, mem: memMB() }); }',
          '        else { const r = await run(d); postMessage(Object.assign({ id: d.id, ok: true }, r)); } }',
          '  catch (err) { postMessage({ id: d.id, ok: false, error: String((err && err.message) || err) }); } };'
        ].join('\n');
      }

      function loadAssets() {
        if (assets) return Promise.resolve(assets);
        if (!assetsP) {
          assetsP = (async () => {
            const a = {
              lib: await cdnFile(ORT_PKG + 'ort.wasm-core.min.js', 'text', 'ONNX Runtime', true),
              wasm: await cdnFile(ORT_PKG + 'ort-wasm-simd.wasm', 'bin', 'ONNX Runtime (wasm)', true),
              det: await cdnFile(PADDLE_PKG + 'ch_PP-OCRv4_det_infer.onnx', 'bin', 'модель поиска текста', true),
              rec: await cdnFile(PADDLE_PKG + 'ch_PP-OCRv4_rec_infer.onnx', 'bin', 'модель иероглифов', true),
              keys: await cdnFile(PADDLE_PKG + 'ppocr_keys_v1.txt', 'text', 'словарь', true)
            };
            assets = a;
            return a;
          })();
          assetsP.then(() => { assetsP = null; }, () => { assetsP = null; });
        }
        return assetsP;
      }
      function loadGpuAssets() {
        if (gpuAssets) return Promise.resolve(gpuAssets);
        if (!gpuAssetsP) {
          gpuAssetsP = (async () => {
            const g = {
              lib: await cdnFile(ORT_PKG + 'ort.webgpu.min.js', 'text', 'ONNX Runtime (видеокарта)', true),
              wasm: await cdnFile(ORT_PKG + 'ort-wasm-simd.jsep.wasm', 'bin', 'ONNX Runtime для видеокарты', true)
            };
            gpuAssets = g;
            return g;
          })();
          gpuAssetsP.then(() => { gpuAssetsP = null; }, () => { gpuAssetsP = null; });
        }
        return gpuAssetsP;
      }

      function call(x, msg, transfer) {
        return new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej, x });
          x.w.postMessage(Object.assign({ id }, msg), transfer || []);
        });
      }

      function kill(x) {
        x.dead = true;
        const i = workers.indexOf(x);
        if (i >= 0) workers.splice(i, 1);
        if (x.w) x.w.terminate();
        for (const [id, p] of pending) if (p.x === x) { pending.delete(id); p.rej(new Error('поток остановлен')); }
      }

      function spawn(gpu) {
        const x = { w: null, gpu, ready: false, busy: true, dead: false, mem: 0 };
        workers.push(x);
        sleeping = false;
        (async () => {
          const a = await loadAssets();
          const g = gpu ? await loadGpuAssets() : null;
          if (x.dead) return;
          if (!srcUrl) srcUrl = URL.createObjectURL(new Blob([source()], { type: 'text/javascript' }));
          const w = new Worker(srcUrl);
          x.w = w;
          w.onmessage = (e) => {
            const p = pending.get(e.data.id);
            if (!p) return;
            pending.delete(e.data.id);
            if (e.data.ok) p.res(e.data); else p.rej(new Error(e.data.error));
          };
          w.onerror = (e) => {
            console.warn('[tb-rub] PaddleOCR: ошибка потока', e && e.message);
            kill(x);
            pump();
          };
          const r = await call(x, { type: 'init', lib: g ? g.lib : a.lib, wasm: g ? g.wasm : a.wasm, det: a.det, rec: a.rec, keys: a.keys, gpu });
          x.mem = r.mem || 0;
        })().then(() => {
          if (x.dead) return;
          x.ready = true; x.busy = false;
          status.paddle = 'ok'; progress = '';
          notify();
          pump();
        }, (e) => {
          kill(x);
          if (gpu) {
            gpuFailed = String((e && e.message) || e).slice(0, 120);
            console.warn('[tb-rub] PaddleOCR: видеокарта недоступна — распознаю на процессоре', e);
          } else if (!workers.some((y) => !y.gpu && y.ready)) {
            failed = true;
            console.warn('[tb-rub] PaddleOCR: фоновые потоки недоступны, распознаю в основном потоке', e);
            waiters.splice(0).forEach((j) => j.rej(e));
          }
          progress = '';
          notify();
          pump();
        });
        return x;
      }

      const target = () => ({ cpu: CpuInfo.plan().k, gpu: state.ocrGpu && !gpuFailed ? 1 : 0 });
      /** Дискретная видеокарта (RTX: фото ≈ 0,34 с против 1,3 с на потоке ЦП) — главный движок, процессор помогает с очередью. */
      const gpuPrimary = () => state.ocrGpu && !gpuFailed && gpuDiscrete();

      /** Свободный готовый поток: со встроенной видеокартой — сначала процессорный (он быстрее), с дискретной — сначала GPU. */
      function pick() {
        const pg = gpuPrimary();
        let best = null;
        for (const x of workers) {
          if (!x.ready || x.busy || x.dead) continue;
          if (!best || (pg ? x.gpu && !best.gpu : best.gpu && !x.gpu)) best = x;
        }
        return best;
      }

      function exec(x, job) {
        x.busy = true;
        call(x, { type: 'run', bmp: job.bmp, W: job.W, H: job.H, minSide: job.minSide || 0 }, [job.bmp]).then((r) => {
          x.mem = r.mem || x.mem;
          const k = x.gpu ? 'gpu' : 'cpu';
          speed[k] = speed[k] ? speed[k] * 0.8 + r.ms * 0.2 : r.ms;
          speed.n++;
          job.res(r.lines);
        }, (e) => job.rej(e)).finally(() => {
          x.busy = false;
          pump();
        });
      }

      function pump() {
        if (failed) return;
        // 1) раздать задания свободным потокам
        for (let x = pick(); x && waiters.length; x = pick()) exec(x, waiters.shift());
        const t = target();
        // 2) потоков не хватает — поднять, не больше разрешённого
        if (waiters.length) {
          let need = waiters.length - workers.filter((x) => !x.ready).length;
          let cpu = workers.filter((x) => !x.gpu).length, gpu = workers.filter((x) => x.gpu).length;
          if (gpuPrimary() && need > 0 && gpu < t.gpu) { spawn(true); gpu++; need--; }
          while (need > 0 && cpu < t.cpu) { spawn(false); cpu++; need--; }
          if (need > 0 && gpu < t.gpu) spawn(true);
        }
        // 3) лишние свободные потоки (уменьшили нагрузку в панели, выключили видеокарту) — закрыть
        const cpus = workers.filter((x) => !x.gpu);
        let extra = cpus.length - t.cpu;
        for (const x of cpus) if (extra > 0 && x.ready && !x.busy) { kill(x); extra--; }
        if (!t.gpu) workers.filter((x) => x.gpu && x.ready && !x.busy).forEach(kill);
        // 4) простой — через минуту освободить память
        clearTimeout(idleT);
        if (!waiters.length && workers.length && workers.every((x) => x.ready && !x.busy)) {
          idleT = setTimeout(() => {
            if (waiters.length || workers.some((x) => !x.ready || x.busy)) return;
            workers.slice().forEach(kill);
            assets = null; gpuAssets = null;               // модели остаются в IndexedDB, в памяти страницы не держим
            sleeping = true;
            notify();
          }, IDLE_MS);
        }
        notify();
      }

      async function run(canvas, W, H, opts) {
        if (failed) throw new Error('пул потоков недоступен');
        const bmp = await createImageBitmap(canvas);
        return new Promise((res, rej) => {
          waiters.push({ bmp, W, H, minSide: (opts && opts.minSide) || 0, res, rej });
          pump();
        });
      }

      /** Поднять один поток заранее (после загрузки страницы), чтобы первое фото не ждало запуска. */
      function init() {
        if (failed) return Promise.reject(new Error('пул потоков недоступен'));
        if (!workers.length) {
          if (status.paddle !== 'ok') { status.paddle = 'loading'; notify(); }
          spawn(gpuPrimary());
          pump();
        }
        return Promise.resolve();
      }
      /** Узнали, что видеокарта дискретная, — заранее поднять её поток (если распознавание уже прогрето). */
      function warmGpu() {
        if (failed || !gpuPrimary() || workers.some((x) => x.gpu) || !workers.length) return;
        spawn(true);
        pump();
      }

      function info() {
        const cpu = workers.filter((x) => !x.gpu), gpu = workers.find((x) => x.gpu);
        return {
          cpu: cpu.length, cpuBusy: cpu.filter((x) => x.busy && x.ready).length,
          gpu: !!gpu, gpuBusy: !!(gpu && gpu.busy && gpu.ready), gpuFailed,
          mem: workers.reduce((s, x) => s + (x.mem || 0), 0),
          queue: waiters.length, sleeping, speedCpu: speed.cpu, speedGpu: speed.gpu, n: speed.n
        };
      }

      return {
        run, init, info, pump,
        gpuRetry: () => { gpuFailed = ''; },
        warmGpu, gpuPrimary,
        size: () => (failed ? 1 : target().cpu + target().gpu),
        ok: () => !failed
      };
    })();

    /** Какая видеокарта достаётся WebGPU (в ноутбуках Chrome обычно берёт встроенную, а не дискретную). */
    let gpuName = null;
    const gpuDiscrete = () => /nvidia/i.test(gpuName || '');
    function gpuInfo() {
      if (gpuName !== null || !navigator.gpu) return gpuName;
      gpuName = '';
      navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).then((a) => {
        const i = (a && a.info) || {};
        const v = String(i.vendor || '').toLowerCase();
        gpuName = !a ? '' : (v === 'nvidia' ? 'NVIDIA' : v === 'amd' ? 'AMD' : v === 'intel' ? 'Intel' : v || 'видеокарта') +
          (i.architecture ? ' ' + i.architecture : '') + (i.description ? ' (' + i.description + ')' : '');
        gpuName = gpuName.trim();
        // дискретная NVIDIA и пользователь не выключал видеокарту сам — включаем её главным движком
        if (gpuDiscrete() && store.get('ocrGpu', null) === null && !state.ocrGpu) state.ocrGpu = true;
        Pool.warmGpu();
        notify();
      }, () => { gpuName = ''; });
      return gpuName;
    }

    /** Заранее, после загрузки страницы: поднять движок, чтобы первое фото не ждало загрузки моделей. */
    function warmup() {
      gpuInfo();
      if (state.ocrEngine === 'vision') return;
      if (state.ocrEngine === 'tesseract') { tessInit().catch(() => {}); return; }
      Pool.init().catch(() => paddleInit().catch((e) => { status.paddle = String((e && e.message) || e).slice(0, 140); notify(); }));
    }
    /** Строка состояния для панели. */
    function describe() {
      const p = status.paddle, t = status.tesseract;
      if (state.ocrEngine === 'vision') return 'Распознавание: Google Vision' + (state.visionKey ? '' : ' — ✗ не задан ключ');
      if (state.ocrEngine === 'tesseract') return 'Распознавание: Tesseract — ' + (t === 'ok' ? 'готово ✓' : t === 'loading' ? 'загрузка…' : t ? '✗ ' + t : 'ждёт первого фото');
      if (progress) return 'Распознавание: ' + progress;
      if (p === 'ok') return 'Распознавание: PaddleOCR ✓' + (Pool.ok() ? '' : ' (основной поток)');
      if (p === 'loading') return 'Распознавание: запуск PaddleOCR…';
      if (p) return 'Распознавание: ✗ PaddleOCR не запустился — ' + p + (t === 'ok' ? ' · работает Tesseract' : '');
      return 'Распознавание: подготовка…';
    }

    async function paddle(src, W, H, opts) {
      const minSide = (opts && opts.minSide) || 0;
      if (Pool.ok()) {
        try {
          const all = await Pool.run(src, W, H, { minSide });
          debug.paddle = all.map((l) => [l.text, Math.round(l.score * 100), Math.round(l.x0), Math.round(l.y0), Math.round(l.x1), Math.round(l.y1)]);
          const lines = all.filter((l) => l.text.trim() && l.score >= 0.5).map((l) => Object.assign({}, l, { text: l.text.trim() }));
          return mergeLines(lines).map((b) => ({ text: tidyOcrText(b.text), verts: rectVerts(b.x0, b.y0, b.x1, b.y1) }));
        } catch (e) {
          if (Pool.ok()) throw e;                      // ошибка конкретной картинки
          // пул не поднялся — ниже основной путь
        }
      }
      const P = await paddleInit();
      let boxes = await paddleDetect(P, src, W, H);
      if (minSide > 0) boxes = boxes.filter((b) => Math.min(b.x1 - b.x0, b.y1 - b.y0) >= minSide);
      const lines = [];
      debug.paddle = [];
      if (boxes.length) say('⏳ PaddleOCR: строк — ' + boxes.length + '…', 60000);
      const recs = await paddleRecLines(P, src, boxes);
      recs.forEach((r, i) => {
        const text = r.text.trim();
        debug.paddle.push([text, Math.round(r.score * 100), Math.round(boxes[i].x0), Math.round(boxes[i].y0), Math.round(boxes[i].x1), Math.round(boxes[i].y1)]);
        if (text && r.score >= 0.5) lines.push(Object.assign({ text }, boxes[i]));
      });
      return mergeLines(lines).map((b) => ({ text: tidyOcrText(b.text), verts: rectVerts(b.x0, b.y0, b.x1, b.y1) }));
    }
 
    // ── Tesseract.js (chi_sim) ──
    let tessP = null;
    function tessInit() {
      if (tessP) return tessP;
      status.tesseract = 'loading';
      tessP = (async () => {
        const code = await cdnFile(TESS_PKG, 'text', 'Tesseract.js');
        const T = evalLib(code, 'Tesseract');
        if (!T || !T.createWorker) throw new Error('Tesseract.js не инициализировался');
        say('⏳ Tesseract: загрузка ядра и модели chi_sim (≈5 МБ, кэшируется браузером)…', 90000);
        const worker = await T.createWorker('chi_sim', 1, {
          errorHandler: (e) => console.warn('[tb-rub] Tesseract:', e)
        });
        status.tesseract = 'ok';
        return worker;
      })();
      tessP.catch((e) => { tessP = null; status.tesseract = String((e && e.message) || e).slice(0, 140); notify(); });
      return tessP;
    }
 
    async function tesseract(src) {
      const worker = await tessInit();
      const blob = await new Promise((res) => src.toBlob(res, 'image/png'));
      const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
      const lines = [];
      const push = (l) => {
        if (!l || !l.bbox) return;
        const text = tidyOcrText(l.text || '');
        if (!text || (typeof l.confidence === 'number' && l.confidence < 45)) return;
        lines.push({ text, x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 });
      };
      for (const b of (data && data.blocks) || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) push(l);
      if (!lines.length && data && data.lines) data.lines.forEach(push);
      return mergeLines(lines).map((b) => ({ text: tidyOcrText(b.text), verts: rectVerts(b.x0, b.y0, b.x1, b.y1) }));
    }
 
    /** Проверка: загружает и запускает движок на маленькой тестовой картинке. */
    async function check(name) {
      const { c, cx } = whiteCanvas(240, 64);
      cx.fillStyle = '#000';
      cx.font = '40px sans-serif';
      cx.fillText('测试', 70, 46);
      const res = name === 'paddle' ? await paddle(c, 240, 64) : await tesseract(c);
      return res.map((b) => b.text).join(' ');
    }
 
    return { paddle, tesseract, check, status, debug, setQuiet, warmup, describe, pool: () => Pool.info(), poolPump: () => Pool.pump(), gpuRetry: () => Pool.gpuRetry(),
      modelsSize: () => modelsSize().catch(() => 0), deleteModels, gpuInfo, gpuPrimary: () => Pool.gpuPrimary(),
      parallel: () => (state.ocrEngine === 'tesseract' ? 1 : Pool.size()) };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  Кэш распознанных фото: IndexedDB этого сайта (по ключу — на страницу читается только нужное).
   *  Лимит по размеру (ползунок в «Дополнительно», 50 МБ – 5 ГБ, модели распознавания входят в лимит,
   *  но сами не удаляются) и срок хранения (неделя / месяц / 3 месяца / всегда).
   * ══════════════════════════════════════════════════════════════════════ */
  const CACHE_TTL_DAYS = { week: 7, month: 30, quarter: 91, forever: 0 };
  // Версия конвейера «распознавание + перевод». Повышаем, когда результат заметно улучшился (2.13: нарезка широких
  // баннеров, построчное распознавание, словарь) — записи со старой версией не используются и удаляются при уборке.
  const OCR_PV = 3;
  const OcrStore = (() => {
    const DB = 'tbrub-ocrcache', ST = 'r', META = '__meta';
    let dbp = null, pruneT = 0, meta = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open(DB, 1);
          r.onupgradeneeded = () => { const st = r.result.createObjectStore(ST); st.createIndex('t', 't'); };
          r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(db); };
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('IndexedDB занята другой вкладкой'));
        });
        dbp.catch(() => { dbp = null; });
      }
      return dbp;
    }
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    const ttlMs = () => (CACHE_TTL_DAYS[state.cacheTTL] || 0) * 864e5;
    const expired = (v) => ttlMs() > 0 && Date.now() - (v.t || 0) > ttlMs();
    const stale = (v) => (v.pv | 0) < OCR_PV;                // распознано старой версией — переделываем
    const sizeOf = (v) => JSON.stringify(v).length + 64;

    /** Первый найденный (не просроченный, текущей версии) результат по списку ключей. */
    async function getFirst(keys) {
      try {
        const db = await open();
        const st = db.transaction(ST).objectStore(ST);
        const vals = await Promise.all(keys.map((k) => req(st.get(k)).catch(() => null)));
        for (let i = 0; i < keys.length; i++) if (vals[i] && !expired(vals[i]) && !stale(vals[i])) return { k: keys[i], v: vals[i] };
      } catch (_) { /* кэш не обязателен */ }
      return null;
    }

    async function readMeta(st) {
      const m = await req(st.get(META)).catch(() => null);
      return m && typeof m.total === 'number' ? m : null;
    }

    async function put(k, v) {
      try {
        const db = await open();
        const rec = Object.assign({}, v, { t: Date.now(), pv: OCR_PV });
        rec.z = sizeOf(rec);
        const tx = db.transaction(ST, 'readwrite');
        const st = tx.objectStore(ST);
        const old = await req(st.get(k)).catch(() => null);
        const m = (await readMeta(st)) || { total: 0, n: 0 };
        m.total += rec.z - (old ? old.z || 0 : 0);
        m.n += old ? 0 : 1;
        st.put(rec, k);
        st.put(m, META);
        await done(tx);
        meta = m;
        schedulePrune(3000);
      } catch (_) { /* кэш не обязателен */ }
    }

    /** Полный пересчёт размера (если счётчик потерян) — проходом по записям. */
    async function recount() {
      const db = await open();
      const tx = db.transaction(ST, 'readwrite');
      const st = tx.objectStore(ST);
      const m = { total: 0, n: 0 };
      await new Promise((res, rej) => {
        const c = st.openCursor();
        c.onsuccess = () => {
          const cur = c.result;
          if (!cur) { res(); return; }
          if (cur.key !== META) { m.total += cur.value.z || sizeOf(cur.value); m.n++; }
          cur.continue();
        };
        c.onerror = () => rej(c.error);
      });
      st.put(m, META);
      await done(tx);
      meta = m;
      return m;
    }

    /** Просроченное и распознанное старой версией — удалить; сверх лимита (вместе с моделями) — удалить самое старое
     *  до 90% лимита. Записи старой версии ищутся полным проходом один раз (после обновления скрипта). */
    async function prune() {
      try {
        const db = await open();
        let m = meta || (await readMeta(db.transaction(ST).objectStore(ST))) || (await recount());
        const models = await OcrEngines.modelsSize().catch(() => 0);
        const limit = state.cacheMB * 1048576;
        const ttl = ttlMs();
        const over = m.total + models - limit;
        const sweep = (m.pv | 0) < OCR_PV;
        if (!(ttl > 0) && over <= 0 && !sweep) { meta = m; return; }
        const target = over > 0 ? m.total - (over + limit * 0.1) : Infinity;   // сколько оставить
        const tx = db.transaction(ST, 'readwrite');
        const st = tx.objectStore(ST);
        m = (await readMeta(st)) || m;
        const cutoff = ttl > 0 ? Date.now() - ttl : 0;
        let gone = 0;
        await new Promise((res, rej) => {
          const c = st.index('t').openCursor();
          c.onsuccess = () => {
            const cur = c.result;
            if (!cur) { res(); return; }
            const v = cur.value;
            if ((cutoff && v.t < cutoff) || m.total > target || (sweep && stale(v))) {
              m.total -= v.z || 0; m.n = Math.max(0, m.n - 1);
              if (sweep && stale(v)) gone++;
              cur.delete();
              cur.continue();
            } else if (sweep) cur.continue();               // ищем старую версию по всему кэшу
            else res();                                     // по возрастанию времени: дальше только свежее
          };
          c.onerror = () => rej(c.error);
        });
        if (m.total < 0) m.total = 0;
        m.pv = OCR_PV;
        if (gone) console.info('[tb-rub] кэш фото: удалено распознанных старой версией — ' + gone + ' (переведутся заново)');
        st.put(m, META);
        await done(tx);
        meta = m;
      } catch (e) { console.warn('[tb-rub] кэш фото: уборка не удалась', e); }
    }
    function schedulePrune(ms) {
      clearTimeout(pruneT);
      pruneT = setTimeout(() => {
        if (window.requestIdleCallback) requestIdleCallback(() => prune(), { timeout: 5000 }); else prune();
      }, ms);
    }

    async function clear() {
      const db = await open();
      const tx = db.transaction(ST, 'readwrite');
      tx.objectStore(ST).clear();
      tx.objectStore(ST).put({ total: 0, n: 0, pv: OCR_PV }, META);
      await done(tx);
      meta = { total: 0, n: 0, pv: OCR_PV };
    }

    async function stats() {
      try {
        const db = await open();
        const m = meta || (await readMeta(db.transaction(ST).objectStore(ST))) || (await recount());
        meta = m;
        return { bytes: m.total, n: m.n };
      } catch (_) { return { bytes: 0, n: 0 }; }
    }

    /** Переезд: старый кэш из хранилища Tampermonkey (общий, грузился на каждой странице) → IndexedDB этого сайта. */
    async function migrate() {
      const old = store.get('ocrCache2', null);
      if (!old || typeof old !== 'object') return;
      const keys = Object.keys(old);
      store.set('ocrCache2', null);                       // по решению: старый кэш удаляем сразу
      if (!keys.length) return;
      try {
        const db = await open();
        const tx = db.transaction(ST, 'readwrite');
        const st = tx.objectStore(ST);
        const m = (await readMeta(st)) || { total: 0, n: 0 };
        for (const k of keys) {
          const v = old[k];
          if (!v || typeof v !== 'object') continue;
          const rec = Object.assign({}, v, { t: v.t || Date.now() });
          rec.z = sizeOf(rec);
          st.put(rec, k);
          m.total += rec.z; m.n++;
        }
        st.put(m, META);
        await done(tx);
        meta = m;
        console.info('[tb-rub] кэш фото перенесён в IndexedDB: ' + keys.length + ' шт.');
      } catch (e) { console.warn('[tb-rub] перенос кэша фото не удался', e); }
    }

    return { getFirst, put, prune, schedulePrune, clear, stats, migrate };
  })();

  /* ══════════════════════════════════════════════════════════════════════
   *  6¾. ПЕРЕВОД ТЕКСТА ПРЯМО НА КАРТИНКЕ (по клику)
   *  Картинка скачивается через GM_xmlhttpRequest (без CORS) → распознавание (PaddleOCR / Tesseract / Google Vision)
   *  → Google Translate → поверх картинки рисуется слой: плашка цвета фона + русский текст по месту оригинала.
   *  Результат кэшируется (память + хранилище), повторный показ не тратит запросы Vision.
   * ══════════════════════════════════════════════════════════════════════ */
  const ImgOcr = (() => {
    const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate?key=';
    const VISION_FEATURE = 'TEXT_DETECTION';
    const overlays = new Map();        // img → {src, root, g, W, H}
    const inflight = new Set();
    const memory = new Map();          // ключ → результат (на время страницы); между визитами — OcrStore (IndexedDB)
    if (store.get('ocrCache1', null)) store.set('ocrCache1', null);
    let raf = 0, frame = 0;
 
    const KEY_HELP =
      'Для перевода текста на картинке нужен ключ Google Cloud Vision API.\n' +
      'Бесплатно: 1000 картинок в месяц (дальше ≈ $1,5 за 1000).\n\n' +
      '1) console.cloud.google.com → создайте проект и привяжите платёжный аккаунт\n' +
      '2) «APIs & Services» → включите Cloud Vision API\n' +
      '3) «Credentials» → Create credentials → API key\n' +
      '   Ограничьте ключ по API (только Cloud Vision). Ограничение по сайтам (HTTP referrer) НЕ ставьте — оно блокирует запросы скрипта.\n\n' +
      'Вставьте ключ (пустая строка — удалить):';
 
    function askKey() {
      const v = window.prompt(KEY_HELP, state.visionKey || '');
      if (v === null) return false;
      state.visionKey = v.trim();
      store.set('visionKey', state.visionKey);
      Ui.render();
      return !!state.visionKey;
    }
 
    function fetchBytes(url) {
      return new Promise((resolve, reject) => {
        if (typeof GM_xmlhttpRequest === 'function') {
          GM_xmlhttpRequest({
            method: 'GET', url, responseType: 'arraybuffer', timeout: 25000,
            onload: (r) => {
              if (!(r.status >= 200 && r.status < 300 && r.response)) { reject(new Error('HTTP ' + r.status)); return; }
              const b = r.response;
              if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) resolve(new Uint8Array(b.buffer || b));
              else if (b && typeof b.arrayBuffer === 'function') b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject);
              else resolve(new Uint8Array(0));
            },
            onerror: () => reject(new Error('network error')),
            ontimeout: () => reject(new Error('timeout'))
          });
        } else {
          fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
            .then((b) => resolve(new Uint8Array(b)), reject);
        }
      });
    }
 
    const absUrl = (u) => (u && u.startsWith('//') ? 'https:' + u : (u || '').replace(/^http:/i, 'https:'));
 
    /** Сначала оригинал в полном размере, при неудаче — тот адрес, что реально на странице. */
    function candidates(img) {
      const src = ImgTr.imgSrc(img);
      // миниатюра товара: хватает той же картинки, что на экране (≈460px), полноразмерную не качаем
      if (ImgTr.isThumb(img)) return [absUrl(src)].filter((u) => u && /^https?:/i.test(u));
      return Array.from(new Set([ImgTr.fullUrl(src), absUrl(src)].filter((u) => u && /^https?:/i.test(u))));
    }
 
    /** Запасной путь: обычный fetch страницы (картинки alicdn отдаются с CORS). */
    const pageFetch = (u) => fetch(u, { mode: 'cors', credentials: 'omit' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then((b) => new Uint8Array(b));

    let lastDl = 0;
    async function download(cands) {
      // бережно к серверам Alibaba: не чаще одной картинки в 350 мс
      const wait = lastDl + 350 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastDl = Date.now();
      let lastErr = new Error('Не удалось скачать картинку');
      for (const u of cands) {
        for (const get of [fetchBytes, pageFetch]) {
          try {
            const bytes = await get(u);
            if (bytes.length > 200 && sniffMime(bytes)) return { url: u, bytes };
            lastErr = new Error('Картинка в неподдерживаемом формате (' + bytes.length + ' байт)');
          } catch (e) { lastErr = e; }
        }
      }
      throw lastErr;
    }
 
    /** Картинка → canvas нужного размера и байты для Vision (при большом размере — пережимаем в JPEG). */
    /** Картинка → canvas (белая подложка) и, для Vision, байты ≤ лимита запроса (иначе пережимаем в JPEG). */
    async function prepare(bytes, forVision) {
      const mime = sniffMime(bytes);
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
      let W = bmp.width, H = bmp.height, send = bytes, ctx;
      const canvas = document.createElement('canvas');
      const draw = (w, h) => {
        canvas.width = w; canvas.height = h;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);
      };
      if (forVision && bytes.length > OCR_MAX_BYTES) {
        let scale = Math.min(1, 3500 / Math.max(W, H));
        for (let i = 0; i < 4; i++) {
          W = Math.max(1, Math.round(bmp.width * scale)); H = Math.max(1, Math.round(bmp.height * scale));
          draw(W, H);
          const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
          send = new Uint8Array(await blob.arrayBuffer());
          if (send.length <= OCR_MAX_BYTES) break;
          scale *= 0.75;
        }
      } else if (!forVision && W > 2400) {
        // уменьшаем до 2400 по ширине, но широкий баннер не сплющиваем: короткая сторона — не меньше 200 px
        const k = Math.min(1, Math.max(2400 / W, Math.min(1, 200 / H)));
        W = Math.round(W * k); H = Math.round(H * k);
        draw(W, H);
      } else draw(W, H);
      if (bmp.close) bmp.close();
      return { W, H, send, ctx };
    }
 
    async function callVision(send) {
      const body = JSON.stringify({ requests: [{ image: { content: bytesToBase64(send) }, features: [{ type: VISION_FEATURE }] }] });
      const txt = await httpReq({
        method: 'POST', url: VISION_URL + encodeURIComponent(state.visionKey),
        headers: { 'Content-Type': 'application/json' }, data: body, timeout: 40000
      });
      const r = (JSON.parse(txt).responses || [])[0] || {};
      if (r.error) throw Object.assign(new Error(r.error.message || 'Vision error'), { visionCode: r.error.code });
      return r;
    }
 
    /** Пачка фраз zh → ru: сначала словарь, остальное — Google (батчи, при склейке строк делим пополам). */
    async function translateMany(list) {
      const out = new Map();
      const todo = [];
      for (const t of list) {
        const l = localTranslate(t);
        const c = l === null ? Translator.cached(t) : undefined;      // общий кэш с переводом страницы — без лишних запросов
        if (l !== null) out.set(t, l); else if (c !== undefined) out.set(t, c); else todo.push(t);
      }
      async function run(items) {
        if (!items.length) return;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const data = JSON.parse(await httpReq({ url: gtxUrl('zh-CN', TL, items.map(prepForGoogle).join('\n')), timeout: 12000 }));
            const joined = parseGtx(data);
            const parts = items.length === 1 ? [joined.trim()] : splitGtx(joined, items.length);
            if (parts) { items.forEach((t, i) => { if (parts[i]) { out.set(t, parts[i]); Translator.remember(t, parts[i]); } }); return; }
            break;                                              // Google склеил строки → делим
          } catch (e) { GNotice.fail(e); if (attempt === 1) return; }
        }
        if (items.length === 1) return;
        const mid = Math.ceil(items.length / 2);
        await run(items.slice(0, mid)); await run(items.slice(mid));
      }
      for (const batch of buildBatches(todo, 3000)) await run(batch);
      return out;
    }
 
    /** Цвет фона: медиана пикселей в узком кольце вокруг рамки текста. */
    function ringColor(ctx, W, H, x0, y0, x1, y1) {
      const t = 3, R = [], G = [], B = [];
      const rects = [[x0 - t, y0 - t, x1 + t, y0], [x0 - t, y1, x1 + t, y1 + t], [x0 - t, y0, x0, y1], [x1, y0, x1 + t, y1]];
      for (const rc of rects) {
        const a = Math.max(0, Math.floor(rc[0])), b = Math.max(0, Math.floor(rc[1]));
        const c = Math.min(W, Math.ceil(rc[2])), d = Math.min(H, Math.ceil(rc[3]));
        if (c - a < 1 || d - b < 1) continue;
        const px = ctx.getImageData(a, b, c - a, d - b).data;
        for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 127) { R.push(px[i]); G.push(px[i + 1]); B.push(px[i + 2]); }
      }
      return R.length ? [median(R), median(G), median(B)].map(Math.round) : [240, 240, 240];
    }
 
    function describeError(e) {
      if (e && e.engine && e.engine !== 'vision') {
        return ENGINE_NAMES[e.engine] + ' не запустился: ' + String(e.message || e).slice(0, 160) +
          '. Выберите другой движок в панели (плашка курса).';
      }
      let msg = '';
      try { msg = (JSON.parse(e.body || '{}').error || {}).message || ''; } catch (_) { /* ignore */ }
      msg = msg || e.message || String(e);
      if (/API key not valid|API_KEY_INVALID/i.test(msg)) return 'Ключ Google Vision недействителен — задайте новый в панели (плашка курса → «Ключ…»).';
      if (e.status === 403 || e.visionCode === 403 || /PERMISSION_DENIED|billing|not been used|disabled/i.test(msg)) {
        return 'Vision отказал в доступе: включите Cloud Vision API и платёжный аккаунт в проекте, ключ не ограничивайте по сайтам. ' + msg.slice(0, 110);
      }
      if (e.status === 429 || e.visionCode === 429) return 'Превышена квота Google Vision.';
      if (/network error|timeout/i.test(msg)) return 'Нет связи с сервером (' + msg + '). Проверьте @connect-разрешения скрипта.';
      return msg.slice(0, 200);
    }
 
    function persist(key, res) {
      OcrStore.put(key, { W: res.W, H: res.H, b: res.b, eng: res.eng });
    }
 
    /** Порядок движков: выбранный в панели или «Авто» (локальные → Vision, если задан ключ; в автопереводе — без Vision). */
    function engineOrder(quiet) {
      if (state.ocrEngine !== 'auto') return [state.ocrEngine];
      return ['paddle', 'tesseract'].concat(state.visionKey && !quiet ? ['vision'] : []);
    }
    const cacheKey = (eng, u, v) => (eng === 'vision' ? u : eng + '|' + u) + (v || '');      // старые записи кэша — от Vision
    /** Миниатюра в режиме «только крупный текст» — свой вариант в кэше (полный результат тоже годится). */
    const variantOf = (opts) => (opts && opts.thumb && opts.dispW > 0 && state.thumbBig ? '|b9' : '');
 
    async function fromCache(engs, cands, v) {
      const keys = [];
      for (const eng of engs) for (const u of cands) for (const k of v ? [cacheKey(eng, u, v), cacheKey(eng, u)] : [cacheKey(eng, u)]) keys.push(k);
      for (const k of keys) if (memory.has(k)) return memory.get(k);
      const hit = await OcrStore.getFirst(keys);
      if (!hit) return null;
      memory.set(hit.k, hit.v);
      return hit.v;
    }
 
    async function runEngine(eng, bytes, quiet, opts) {
      if (eng === 'vision') {
        if (!state.visionKey) throw new Error('не задан ключ Google Vision');
        const p = await prepare(bytes, true);
        if (!quiet) toast('⏳ Распознаю текст (Google Vision)…', 40000);
        return { W: p.W, H: p.H, ctx: p.ctx, blocks: visionToBlocks(await callVision(p.send)) };
      }
      const p = await prepare(bytes, false);
      if (!quiet) toast('⏳ Распознаю текст (' + ENGINE_NAMES[eng] + ', на вашем компьютере)…', 120000);
      const t0 = performance.now();
      OcrEngines.setQuiet(quiet);
      let blocks;
      // миниатюра: строки мельче 9px на экране не распознаём (в пикселях исходника: 9 × ширина фото / ширина на экране)
      const minSide = variantOf(opts) ? (9 * p.W) / opts.dispW : 0;
      try { blocks = eng === 'paddle' ? await OcrEngines.paddle(p.ctx.canvas, p.W, p.H, { minSide }) : await OcrEngines.tesseract(p.ctx.canvas); }
      finally { OcrEngines.setQuiet(false); }
      Perf.add('Распознавание фото', performance.now() - t0);
      return { W: p.W, H: p.H, ctx: p.ctx, blocks };
    }
 
    /** Полный конвейер для картинки → результат {W,H,b:[…]} (из кэша или через движок OCR). */
    async function recognize(img, quiet) {
      // автоперевод миниатюры — «только крупный текст»; по клику пользователь получает всё
      const opts = quiet && ImgTr.isThumb(img) ? { thumb: true, dispW: img.getBoundingClientRect().width || img.clientWidth || 0 } : null;
      return recognizeCands(candidates(img), quiet, opts);
    }

    /** Фоновая подготовка перевода по адресу (фото галереи товара, которые показываются при наведении на миниатюру). */
    async function prefetch(url) {
      if (!url || (await fromCache(engineOrder(true), [url]))) return false;
      try { await recognizeCands([url], true); return true; } catch (_) { return false; }
    }

    /** Одна и та же картинка дважды одновременно (клоны слайдов карусели, фото галереи и его предзагрузка) —
     *  распознаём один раз, второй запрос ждёт результат первого. */
    const sameUrl = new Map();
    function recognizeCands(cands, quiet, opts) {
      if (!cands.length) return Promise.reject(new Error('Не удалось определить адрес картинки'));
      const k = cands[0] + '|' + engineOrder(quiet).join(',') + variantOf(opts);
      if (sameUrl.has(k)) return sameUrl.get(k);
      const p = recognizeCandsRaw(cands, quiet, opts);
      sameUrl.set(k, p);
      p.then(() => sameUrl.delete(k), () => sameUrl.delete(k));
      return p;
    }
    async function recognizeCandsRaw(cands, quiet, opts) {
      const engs = engineOrder(quiet);
      const v = variantOf(opts);
      const hit = await fromCache(engs, cands, v);
      if (hit && hit.b && !hit.b.length) throw Object.assign(new Error('Китайский текст на картинке не найден'), { silent: true, info: true });
      if (hit) return hit;
      if (engs.length === 1 && engs[0] === 'vision' && !state.visionKey && !askKey()) {
        throw Object.assign(new Error('Нужен ключ Google Vision'), { silent: true });
      }
 
      if (!quiet) toast('⏳ Скачиваю картинку…', 20000);
      const { url, bytes } = await download(cands);
      let got = null, lastErr = null;
      for (const eng of engs) {
        try { got = await runEngine(eng, bytes, quiet, opts); got.eng = eng; break; } catch (e) {
          lastErr = Object.assign(e, { engine: eng });
          console.warn('[tb-rub] OCR ' + eng + ':', e);
          if (engs.length > 1 && !quiet) toast('⚠ ' + ENGINE_NAMES[eng] + ' не сработал — пробую следующий движок…', 4000);
        }
      }
      if (!got) throw lastErr;
      const { W, H, ctx, eng } = got;
      const raw = got.blocks.filter((b) => CJK_RE.test(b.text));
      const items = raw.map((b) => ({ text: b.text, q: quadInfo(b.verts), verts: b.verts }))
        .filter((x) => x.q.h >= 8 && x.q.w >= 8)
        // одиночный иероглиф-значок (保, 新, 赠 в кружке) не переводим — плашка закрыла бы иконку
        .filter((x) => (x.text.match(/[\u3400-\u9fff]/g) || []).length >= 2 || /[0-9A-Za-z]/.test(x.text));
      if (!items.length) {
        const empty = { W, H, b: [], eng };                // запоминаем «текста нет» — при следующем визите не распознаём заново
        const ke = cacheKey(eng, url, v);
        memory.set(ke, empty);
        persist(ke, empty);
        throw Object.assign(new Error('Китайский текст на картинке не найден (' + ENGINE_NAMES[eng] + ')'), { silent: true, info: true });
      }
      if (!quiet) toast('⏳ Перевожу ' + items.length + ' фрагм.…', 30000);
      const tr = await translateMany(Array.from(new Set(items.map((x) => x.text))));
      const res = { W, H, b: [], eng };
      for (const it of items) {
        const t = tr.get(it.text);
        if (!t) continue;                                       // не перевелось — оставляем оригинал
        const xs = it.verts.map((p) => p.x), ys = it.verts.map((p) => p.y);
        const pad = Math.max(2, it.q.h * 0.1);
        const bg = ringColor(ctx, W, H, Math.min.apply(null, xs) - pad, Math.min.apply(null, ys) - pad,
          Math.max.apply(null, xs) + pad, Math.max.apply(null, ys) + pad);
        const n = (it.text.match(/[\u3400-\u9fff]/g) || []).length;
        const m = (it.text.match(/[0-9A-Za-z%.+\-]/g) || []).length;
        const r1 = (v) => Math.round(v * 10) / 10;
        res.b.push({ tr: t, cx: r1(it.q.cx), cy: r1(it.q.cy), w: r1(it.q.w), h: r1(it.q.h), ang: r1(it.q.ang), n, m, bg });
      }
      if (!res.b.length) throw Object.assign(new Error('Не удалось перевести текст на картинке'), { silent: true });   // сбой перевода — автоперевод повторит
      const k = cacheKey(eng, url, v);
      memory.set(k, res);
      persist(k, res);
      return res;
    }
 
    /** Подбор размера шрифта, чтобы перевод поместился в рамку (бинарный поиск). */
    // Подбор кегля без вёрстки: ширина слов меряется на canvas (measureText), перенос считается сами.
    // Раньше каждый шаг двоичного поиска заставлял браузер пересчитывать раскладку страницы.
    const OCR_FONT = '-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
    let measCtx = null;
    const wordW = new Map();                          // «кегль|слово» → ширина (повторяются часто)
    function textFits(words, f, w, h) {
      if (!measCtx) measCtx = document.createElement('canvas').getContext('2d');
      measCtx.font = '500 ' + f + 'px ' + OCR_FONT;
      const width = (t) => { const k = f + '|' + t; let v = wordW.get(k); if (v === undefined) { v = measCtx.measureText(t).width; if (wordW.size > 5000) wordW.clear(); wordW.set(k, v); } return v; };
      const space = width(' ');
      let lines = 1, cur = -1;
      for (const wd of words) {
        const ww = width(wd);
        if (ww > w) return false;                     // слова не рвём
        if (cur < 0) cur = ww;
        else if (cur + space + ww <= w) cur += space + ww;
        else { lines++; cur = ww; }
      }
      return lines * f * 1.1 <= h;
    }
    function fitFont(el, sp, hi, minFs) {
      const w = (parseFloat(el.style.width) || el.clientWidth) * 0.97, h = parseFloat(el.style.height) || el.clientHeight;
      const words = String(sp.textContent || '').split(/\s+/).filter(Boolean);
      let lo = minFs || 5;
      hi = Math.max(hi, lo);
      let best = lo;
      for (let i = 0; i < 9 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2;
        if (textFits(words, mid, w, h)) { best = mid; lo = mid; } else hi = mid;
      }
      sp.style.fontSize = best + 'px';
      return best;
    }
 
    function removeOverlay(img) {
      const o = overlays.get(img);
      if (!o) return;
      o.root.remove();
      if (o.ro) o.ro.disconnect();
      if (o.relHost && !o.relHost.querySelector(':scope > .tbrub-ocr,:scope > .tbrub-tap')) o.relHost.style.removeProperty('position');
      overlays.delete(img);
      ImgTr.refresh();
    }

    /** Слой живёт рядом с картинкой (в том же контейнере) — прокручивается вместе со страницей без участия скрипта. */
    function hostOf(img) {
      let h = img.parentElement;
      if (h && h.tagName === 'PICTURE') h = h.parentElement;
      return h;
    }
 
    function posFrac(str) {
      const t = String(str || '50% 50%').split(/\s+/);
      const f = (v) => (v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? 1 : /%$/.test(v) ? parseFloat(v) / 100 : 0.5);
      return [f(t[0]), f(t[1] || t[0])];
    }
 
    /** Положение и масштаб слоя: пересчитываются при изменении размера картинки или её контейнера (ResizeObserver)
     *  и по окончании CSS-анимации картинки — не на каждом кадре. */
    const TF_PROPS = ['transform', 'translate', 'rotate', 'scale'];
    function place(img, o) {
      if (!img.isConnected || ImgTr.imgSrc(img) !== o.src) { removeOverlay(img); return; }
      const host = hostOf(img);
      if (!host) return;
      if (o.root.parentNode !== host) host.appendChild(o.root);       // страница перерисовала контейнер — возвращаем слой
      if (getComputedStyle(host).position === 'static') { host.style.position = 'relative'; o.relHost = host; }
      if (o.ro && o.obsHost !== host) { o.ro.observe(host); o.obsHost = host; }   // центрирование зависит от ширины контейнера
      let w = img.offsetWidth, h = img.offsetHeight;
      if (w < 2 || h < 2) { o.root.style.visibility = 'hidden'; return; }
      const c = getComputedStyle(img);
      const st = o.root.style;
      // координаты картинки внутри контейнера
      let x = img.offsetLeft, y = img.offsetTop, own = false;
      if (img.offsetParent === host) {
        // offsetLeft/Top не учитывают CSS-трансформации картинки: широкий баннер, отцентрованный через
        // left:50% + translateX(-50%), «уезжал» вбок за край экрана. Повторяем трансформацию на слое — он того же размера.
        own = true;
      } else {
        const a = img.getBoundingClientRect(), b = host.getBoundingClientRect();
        const hx = host.offsetWidth > 0 ? b.width / host.offsetWidth || 1 : 1;   // контейнер сам может быть масштабирован
        const hy = host.offsetHeight > 0 ? b.height / host.offsetHeight || 1 : 1;
        x = (a.left - b.left) / hx - host.clientLeft + host.scrollLeft; y = (a.top - b.top) / hy - host.clientTop + host.scrollTop;
        w = a.width / hx; h = a.height / hy;
      }
      const tfv = TF_PROPS.map((p) => (own && c[p] && c[p] !== 'none' ? c[p] : ''));
      TF_PROPS.forEach((p, i) => { st[p] = tfv[i]; });
      o.tf = tfv.some(Boolean) ? tfv.join(';') + ';' : '';
      st.transformOrigin = o.tf ? c.transformOrigin : '';
      const fit = c.objectFit;
      const kx = w / o.W, ky = h / o.H;
      let sx = kx, sy = ky;
      if (fit === 'contain') sx = sy = Math.min(kx, ky);
      else if (fit === 'cover') sx = sy = Math.max(kx, ky);
      else if (fit === 'none') sx = sy = 1;
      else if (fit === 'scale-down') sx = sy = Math.min(1, kx, ky);
      const pos = posFrac(c.objectPosition);
      const ox = (w - o.W * sx) * pos[0], oy = (h - o.H * sy) * pos[1];
      st.left = x + 'px'; st.top = y + 'px'; st.width = w + 'px'; st.height = h + 'px';
      st.visibility = c.visibility === 'hidden' ? 'hidden' : 'visible';
      o.g.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + sx + ',' + sy + ')';
    }
    const tfOf = (img) => { const c = getComputedStyle(img); return TF_PROPS.map((p) => (c[p] && c[p] !== 'none' ? c[p] : '')).join(';') + ';'; };   // формат как o.tf

    /** Раз в секунду: картинка сменилась/исчезла → убрать слой; контейнер перерисован → вернуть слой на место. */
    function validate() {
      for (const [img, o] of Array.from(overlays)) {
        if (!img.isConnected || ImgTr.imgSrc(img) !== o.src) { removeOverlay(img); continue; }
        if (o.root.parentNode !== hostOf(img) || (o.tf && tfOf(img) !== o.tf)) place(img, o);
        if (o.video && (!o.video.isConnected || o.video.paused || o.video.ended || !o.video.offsetWidth)) showOverVideo(o, null);
      }
    }
    // картинка с анимацией (увеличение при наведении, слайды) — слой догоняет её, когда анимация закончилась
    const onAnimEnd = (e) => { const t = e.target, o = t && t.tagName === 'IMG' && overlays.get(t); if (o) place(t, o); };
    ['transitionend', 'transitioncancel', 'animationend'].forEach((t) => document.addEventListener(t, onAnimEnd, true));

    /* Видео на карточке (Taobao проигрывает его при наведении): пока оно идёт поверх фото — наш перевод прячем,
     * иначе надписи висят поверх кадров видео. По желанию (Дополнительно) такие видео вообще не проигрываем. */
    function showOverVideo(o, v) {
      o.video = v;
      o.root.classList.toggle('tbrub-under-video', !!v);
    }
    function covers(v, img) {
      const a = v.getBoundingClientRect(), b = img.getBoundingClientRect();
      const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return b.width > 0 && ix * iy > 0.4 * b.width * b.height;
    }
    function onVideo(e) {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      if (e.type === 'play' || e.type === 'playing') {
        if (state.noThumbVideo && ImgTr.isThumb(v)) { try { v.pause(); } catch (_) { /* ignore */ } return; }
        for (const [img, o] of overlays) if (covers(v, img)) showOverVideo(o, v);
      } else {
        for (const o of overlays.values()) if (o.video === v) showOverVideo(o, null);
      }
    }
    ['play', 'playing', 'pause', 'ended', 'emptied', 'abort'].forEach((t) => document.addEventListener(t, onVideo, true));
    setInterval(() => { if (overlays.size) validate(); }, 1000);

    // старый вариант (position:fixed + пересчёт на каждом кадре) — оставлен только для справки, не используется
    function syncOne(img, o, n) {
      if (!img.isConnected || ImgTr.imgSrc(img) !== o.src) { removeOverlay(img); return; }
      const r = img.getBoundingClientRect();
      const ix0 = Math.max(r.left, 0), iy0 = Math.max(r.top, 0), ix1 = Math.min(r.right, innerWidth), iy1 = Math.min(r.bottom, innerHeight);
      if (r.width < 2 || r.height < 2 || ix1 - ix0 < 2 || iy1 - iy0 < 2) { o.root.style.visibility = 'hidden'; return; }
      if (!o.cs || n % 30 === 0) { const c = getComputedStyle(img); o.cs = { objectFit: c.objectFit, objectPosition: c.objectPosition, visibility: c.visibility }; }
      const cs = o.cs;
      const fit = cs.objectFit;
      const kx = r.width / o.W, ky = r.height / o.H;
      let sx = kx, sy = ky;
      if (fit === 'contain') sx = sy = Math.min(kx, ky);
      else if (fit === 'cover') sx = sy = Math.max(kx, ky);
      else if (fit === 'none') sx = sy = 1;
      else if (fit === 'scale-down') sx = sy = Math.min(1, kx, ky);
      const pos = posFrac(cs.objectPosition);
      const ox = (r.width - o.W * sx) * pos[0], oy = (r.height - o.H * sy) * pos[1];
      const st = o.root.style;
      st.left = r.left + 'px'; st.top = r.top + 'px'; st.width = r.width + 'px'; st.height = r.height + 'px';
      o.g.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + sx + ',' + sy + ')';
      if (n % 6 === 0 || st.visibility === 'hidden') {                            // перекрыта ли картинка шапкой/окном
        const top = document.elementFromPoint((ix0 + ix1) / 2, (iy0 + iy1) / 2);
        const box = img.parentElement && (img.parentElement.parentElement || img.parentElement);
        const ok = !top || top === img || (box && box.contains(top)) ||
          (top.closest && top.closest('#tbrub-root,#tbrub-imgbtn,#tbrub-toast'));
        st.visibility = ok && cs.visibility !== 'hidden' ? 'visible' : 'hidden';
      }
    }
 
    function loop() {
      raf = 0;
      if (!overlays.size) return;
      frame++;
      for (const [img, o] of Array.from(overlays)) syncOne(img, o, frame);
      raf = requestAnimationFrame(loop);
    }
 
    const rectOf = (b, kw, kh, W, H) => {
      const pad = Math.max(2, b.h * 0.1);
      const bw = Math.min((b.w + 2 * pad) * kw, W), bh = Math.min((b.h + 2 * pad) * kh, H);
      let x = b.cx - bw / 2, y = b.cy - bh / 2;
      if (!b.ang) { x = Math.max(0, Math.min(W - bw, x)); y = Math.max(0, Math.min(H - bh, y)); }
      return { x, y, w: bw, h: bh };
    };
    const overlapArea = (a, c) => Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x)) *
      Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y));
    /** Оценка исходного кегля: иероглиф ≈ квадрат, латиница/цифры ≈ половина ширины. */
    function srcFont(b) {
      const units = Math.max(1, b.n + 0.5 * Math.max(0, (b.m || 0)));
      return Math.min(b.h, Math.sqrt((b.w * b.h) / units));
    }

    function show(img, res) {
      removeOverlay(img);
      const root = document.createElement('div');
      root.className = 'tbrub-ocr notranslate';
      root.setAttribute('translate', 'no');
      root.setAttribute('lang', 'ru');                 // для переносов (hyphens:auto)
      root.style.visibility = 'hidden';
      const g = document.createElement('div');
      g.className = 'tbrub-ocr-g';
      g.style.width = res.W + 'px';
      g.style.height = res.H + 'px';
      root.appendChild(g);
      (hostOf(img) || document.body).appendChild(root);

      // не мельче ~7px на экране (миниатюры показываются уменьшенными)
      const shown = img.getBoundingClientRect().width || res.W;
      const minFs = Math.max(5, Math.min(7 * res.W / shown, 40));
      // дубли распознавания (одна надпись двумя рамками) — оставляем бо́льшую
      const blocks = res.b.slice().sort((a, c) => c.w * c.h - a.w * a.h);
      const base = [];
      const kept = [];
      for (const b of blocks) {
        const r = rectOf(b, 1, 1, res.W, res.H);
        if (base.some((o) => overlapArea(o, r) > 0.6 * r.w * r.h)) continue;
        base.push(r); kept.push(b);
      }
      // плашки не выходят за свою рамку дальше, чем позволяют соседи: без наложений друг на друга
      const placed = [];
      const STEPS = [[1, 1], [1.25, 1], [1, 1.25], [1.25, 1.25], [1.5, 1.2], [1.2, 1.5], [1.6, 1.6]];
      kept.forEach((b, idx) => {
        const el = document.createElement('div');
        el.className = 'tbrub-ocr-b';
        const sp = document.createElement('span');
        sp.textContent = b.tr;
        el.appendChild(sp);
        el.style.background = 'rgb(' + b.bg.join(',') + ')';
        el.style.color = textColorFor(b.bg);
        el.style.transform = 'rotate(' + (b.ang || 0) + 'deg)';
        g.appendChild(el);
        const fo = srcFont(b);
        const setRect = (r) => { el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; };
        let best = null;
        for (const [kw, kh] of STEPS) {
          const r = rectOf(b, kw, kh, res.W, res.H);
          if (kw !== 1 || kh !== 1) {
            const own = base[idx];
            const hits = base.some((o, j) => j !== idx && overlapArea(o, r) > 0.02 * r.w * r.h) ||
              placed.some((o) => overlapArea(o, r) > 0.02 * r.w * r.h);
            if (hits || overlapArea(own, r) < own.w * own.h * 0.99) continue;
          }
          setRect(r);
          const f = fitFont(el, sp, Math.min(r.h * 0.9, fo), minFs);    // не крупнее исходного текста
          if (!best || f > best.f + 0.3) best = { r, f };
          if (f >= fo * 0.7) break;                                     // читаемо — дальше не расширяем
        }
        setRect(best.r);
        fitFont(el, sp, Math.min(best.r.h * 0.9, fo), minFs);
        placed.push(best.r);
      });
      try {                                                      // отладка: что распознано и как переведено
        root.setAttribute('data-tbrub-debug', JSON.stringify({ eng: res.eng, W: res.W, H: res.H,
          b: res.b.map((b) => [b.tr, Math.round(b.cx), Math.round(b.cy), Math.round(b.w), Math.round(b.h)]),
          raw: res.eng === 'paddle' ? OcrEngines.debug.paddle : undefined }));
      } catch (_) { /* не важно */ }
      const o = { src: ImgTr.imgSrc(img), root, g, W: res.W, H: res.H, relHost: null, ro: null, obsHost: null, tf: '' };
      overlays.set(img, o);
      place(img, o);
      if (typeof ResizeObserver === 'function') { o.ro = new ResizeObserver(() => place(img, o)); o.ro.observe(img); }
    }

    async function toggle(img, quiet) {
      if (!img) return 'skip';
      if (overlays.has(img)) { if (!quiet) removeOverlay(img); return 'skip'; }
      if (inflight.has(img)) return 'skip';
      inflight.add(img);
      ImgTr.refresh();
      let status = 'error';
      try {
        const res = await recognize(img, quiet);
        if (img.isConnected) show(img, res);
        status = 'ok';
        if (!quiet) toast('Переведено фрагментов: ' + res.b.length + (res.eng ? ' · ' + ENGINE_NAMES[res.eng] : '') + ' · «↩ Оригинал» убирает перевод', 2600);
      } catch (e) {
        status = e && e.info ? 'empty' : 'error';
        if (!(e && e.info)) console.warn('[tb-rub] перевод на картинке:', e);
        if (e && e.silent) { if (!quiet) toast(e.info ? e.message : 'Перевод на картинке отменён', e.info ? 3500 : 1500); }
        else if (!quiet) toast('⚠ ' + describeError(e), 9000);
      } finally {
        inflight.delete(img);
        ImgTr.refresh();
      }
      return status;
    }
 
    return {
      toggle, askKey, prefetch,
      has: (img) => overlays.has(img),
      busy: (img) => inflight.has(img),
      removeAll: () => Array.from(overlays.keys()).forEach(removeOverlay),
      validate
    };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  6⅞. АВТОПЕРЕВОД ФОТО НА СТРАНИЦЕ ТОВАРА
   *  Крупные фото (галерея, описание) переводятся по очереди, когда попадают на экран. По одной за раз.
   * ══════════════════════════════════════════════════════════════════════ */
  const isItemPage = () => /(^|\.)(item\.taobao|detail\.tmall|detail\.taobao|item\.tmall)\.com$/.test(location.hostname) ||
    /\/item\.htm/.test(location.pathname) || !!document.querySelector('[class*="MainTitle--"],[class*="mainTitle--"]') ||
    // мобильная карточка: main.m.taobao.com/…detail…?id=, h5.m.taobao.com/awp/core/detail.htm?id=, detail.m.tmall.com/item.htm?id=
    (MOBILE && /detail|item/i.test(location.pathname) && /[?&](?:id|itemId)=\d/.test(location.search));
 
  const ImgAuto = (() => {
    let io = null, timer = 0, busy = false, loadHooked = false;
    let seen = new WeakSet();
    const tried = new WeakMap();      // img → src, для которого уже пробовали
    const queue = [];
    // «Перевод фото заранее» (ползунок в панели). То, что на экране, всегда переводится всеми потоками.
    //   0 Экран   — только видимое;
    //   1 Бережно — заранее одним потоком, пауза во время прокрутки, ~3 экрана вперёд;
    //   2 Быстро  — заранее всеми потоками, пауза во время прокрутки, ~6 экранов;
    //   3 Макс    — всеми потоками без пауз, ~6 экранов.
    const AHEAD = [
      { threads: 0, pause: true, lazy: 0, margin: '100px 0px 200px 0px', below: 200 },
      { threads: 1, pause: true, lazy: 3, margin: '800px 0px 3000px 0px', below: 3000 },
      { threads: 99, pause: true, lazy: 6, margin: '800px 0px 3000px 0px', below: 3000 },
      { threads: 99, pause: false, lazy: 6, margin: '800px 0px 3000px 0px', below: 3000 }
    ];
    const cfg = () => AHEAD[state.imgAhead] || AHEAD[1];
    let lastScroll = 0, resumeT = 0, activeAhead = 0;
 
    function onIntersect(entries) {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        seen.delete(e.target);                       // догрузится/сменит src — заметим при следующем обходе
        if (!queue.includes(e.target)) queue.push(e.target);
      }
      pump();
    }

    /** Карточка товара: все крупные фото. Остальные страницы: только баннеры (широкие или крупные картинки вне карточек товаров). */
    function autoEligible(img) {
      if (ImgTr.isThumb(img)) {                      // миниатюры товаров: поиск, лента, «С этим смотрят»
        if (!state.imgThumbs) return false;
        const r = img.getBoundingClientRect();
        return r.width >= 90 && r.height >= 90 && !!ImgTr.fullUrl(ImgTr.imgSrc(img));
      }
      if (isItemPage()) return ImgTr.eligible(img, 260, 120);
      if (!ImgTr.eligible(img, 300, 50)) return false;
      const r = img.getBoundingClientRect();
      return r.width / r.height >= 2 || (r.width >= 480 && r.height >= 240);
    }

    /** Ближайшие к экрану картинки — первыми: что видно сейчас, потом то, до чего пользователь доскроллит.
     *  Положение всех картинок меряем один раз за проход (раньше — заново на каждую взятую из очереди). */
    function sortQueue() {
      const vh = innerHeight, d = new Map();
      for (const img of queue) {
        const r = img.getBoundingClientRect();
        const vis = r.bottom > -100 && r.top < vh + 100 && (r.width > 0 || r.height > 0);
        d.set(img, { dist: r.bottom < 0 ? -r.bottom + 2000 : Math.max(0, r.top - vh), top: r.top, bottom: r.bottom, vis });
      }
      queue.sort((a, b) => d.get(a).dist - d.get(b).dist);
      return d;
    }
 
    let active = 0;
    /** Несколько фото параллельно — по числу потоков распознавания. Сначала то, что на экране (всеми потоками),
     *  потом «заранее» — сколько и когда, решает ползунок «Перевод фото заранее». */
    function pump() {
      const limit = OcrEngines.parallel();
      if (active >= limit || !queue.length || !state.imgAuto || !state.imgTr || Guard.paused()) return;
      const c = cfg();
      const aheadLimit = Math.min(limit, c.threads);
      const scrolling = c.pause && Date.now() - lastScroll < 800;
      const later = [];                                // отложенные (заранее/далеко) — вернём в очередь
      const pos = sortQueue();
      while (active < limit && queue.length) {
        const img = queue.shift();
        const r = pos.get(img);
        if (!img.isConnected || ImgOcr.has(img) || ImgOcr.busy(img)) continue;
        const vis = !!(r && r.vis);
        if (!vis) {
          // миниатюры заранее — не дальше полутора экранов и никогда во вкладке в фоне
          const thumbFar = ImgTr.isThumb(img) && (document.hidden || r.top > innerHeight * 1.5 || r.bottom < -innerHeight * 0.5);
          if (thumbFar || activeAhead >= aheadLimit || scrolling) { later.push(img); continue; }
        }
        if (!autoEligible(img)) continue;
        const src = ImgTr.imgSrc(img);
        if (tried.get(img) === src) continue;
        tried.set(img, src);
        active++;
        if (!vis) activeAhead++;
        busy = true;
        ImgOcr.toggle(img, true).then((st) => {
          if (st === 'error') setTimeout(() => { if (tried.get(img) === src) tried.delete(img); }, 30000);   // сбой сети — повторим позже
        }).finally(() => {
          active--;
          if (!vis) activeAhead--;
          busy = active > 0;
          pump();
          if (!active) prefetchGallery();
        });
      }
      if (later.length) queue.push(...later);
      if (scrolling && later.length) {                 // прокрутка закончится — продолжим «заранее»
        clearTimeout(resumeT);
        resumeT = setTimeout(pump, 850);
      }
    }
 
    /** Фото галереи товара (слева): показываются при наведении на миниатюру — готовим перевод заранее, по адресу. */
    const galleryDone = new Set();
    let galleryBusy = false;
    async function prefetchGallery() {
      if (galleryBusy || !state.imgAhead || !isItemPage() || !state.imgAuto || !state.imgTr || Guard.paused()) return;
      const urls = Array.from(document.querySelectorAll('[class*="thumbnailItem--"] img,[class*="thumbnail--"] img'))
        .map((i) => ImgTr.fullUrl(ImgTr.imgSrc(i))).filter((u) => u && !galleryDone.has(u));
      if (!urls.length) return;
      galleryBusy = true;
      try {
        for (const u of urls) {
          if (busy) break;                             // фото на экране важнее — продолжим на следующем проходе
          galleryDone.add(u);
          await ImgOcr.prefetch(u);
        }
      } finally { galleryBusy = false; }
    }

    /** Описание товара: Taobao грузит фото только при прокрутке. Запускаем загрузку сами — на 3–6 экранов вперёд
     *  (по ползунку «Перевод фото заранее»), чтобы к моменту прокрутки картинка уже была скачана и переведена. */
    function preloadLazy() {
      if (!cfg().lazy || !isItemPage() || Guard.paused()) return;
      const limit = innerHeight * cfg().lazy;
      for (const img of document.querySelectorAll('img[data-src],img[data-ks-lazyload],img[data-lazy-src]')) {
        if (!ImgTr.isPlaceholder(img) || ImgTr.isThumb(img)) continue;
        const lz = ImgTr.lazySrc(img);
        if (!lz || /^data:/i.test(lz)) continue;
        const r = img.getBoundingClientRect();
        if (r.top > limit || r.bottom < -innerHeight) continue;
        img.src = lz.startsWith('//') ? 'https:' + lz : lz;
      }
    }

    /** Картинка сменила адрес (галерея, карусель): если перевод уже готов — показываем сразу. */
    function onLoad(img) {
      if (!io || !state.imgAuto || !state.imgTr || !img.isConnected || ImgOcr.has(img) || ImgOcr.busy(img)) return;
      if (!autoEligible(img)) return;
      const src = ImgTr.imgSrc(img);
      if (tried.get(img) === src) return;
      if (!queue.includes(img)) queue.unshift(img);
      pump();
    }

    function scan() {
      if (!io) return;
      preloadLazy();
      // во вкладке в фоне IntersectionObserver молчит — проверяем положение картинок сами (товар открыт в фоне → фото готовы)
      const broken = Translator.ioBroken() || document.hidden;
      let added = false;
      for (const img of document.images) {
        if (tried.get(img) === ImgTr.imgSrc(img)) continue;
        if (broken) {                                  // IntersectionObserver молчит — проверяем положение сами
          if (document.hidden && ImgTr.isThumb(img)) continue;   // миниатюры в фоне всё равно не распознаём
          const r = img.getBoundingClientRect();
          if (r.width && r.bottom > -800 && r.top < innerHeight + cfg().below && !queue.includes(img)) { queue.push(img); added = true; }
          continue;
        }
        if (seen.has(img)) continue;
        seen.add(img);
        io.observe(img);
      }
      if (added) pump();
      if (!busy) prefetchGallery();
    }
 
    let scrollT = 0;
    const onScroll = () => {
      lastScroll = Date.now();
      if (!scrollT) scrollT = setTimeout(() => { scrollT = 0; if (queue.length) pump(); }, 250);
    };

    function start() {
      if (io || !state.imgAuto || !state.imgTr || !document.body) return;
      window.addEventListener('scroll', onScroll, { passive: true });
      // заранее, с запасом ~3 экрана ниже (кроме режима «Экран»): к моменту прокрутки фото уже переведено
      io = new IntersectionObserver(onIntersect, { rootMargin: cfg().margin, threshold: 0 });
      scan();
      timer = setInterval(scan, 2000);
      if (!loadHooked) {
        loadHooked = true;
        document.addEventListener('load', (e) => { const t = e.target; if (t && t.tagName === 'IMG') onLoad(t); }, true);
      }
    }
 
    function stop() {
      if (io) io.disconnect();
      io = null;
      clearInterval(timer);
      clearTimeout(resumeT);
      queue.length = 0;
      seen = new WeakSet();
    }
 
    /** Сменили «Перевод фото заранее» — новые границы наблюдения; уже переведённое не трогаем. */
    function restart() {
      if (!io) return;
      stop();
      start();
      pump();
    }

    function stats() {
      let vis = 0, ahead = 0;
      for (const img of queue) {
        if (!img.isConnected || ImgOcr.has(img)) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom > -100 && r.top < innerHeight + 100 && (r.width > 0 || r.height > 0)) vis++; else ahead++;
      }
      return { vis, ahead, active };
    }

    return { start, stop, restart, pump, stats };
  })();

  /* ══════════════════════════════════════════════════════════════════════
   *  6⅞½. ТЕЛЕФОН: значок «文» на крупных фото и выбор режима перевода фото
   *  Наведения мышью нет — у крупных фото рядом с экраном появляется значок: нажатие переводит надписи прямо
   *  на фото (повторное — оригинал), долгое нажатие — Google Lens / Яндекс / 1688. Значок живёт в контейнере
   *  фото и прокручивается вместе со страницей без участия скрипта.
   * ══════════════════════════════════════════════════════════════════════ */
  const MobImg = (() => {
    const badges = new Map();          // img → { el, rel, st }
    const inView = new Set();          // фото рядом с экраном (по IntersectionObserver)
    let io = null, timer = 0, seen = new WeakSet();
    const hostOf = (img) => { let h = img.parentElement; if (h && h.tagName === 'PICTURE') h = h.parentElement; return h; };

    /** Крупные фото товара/описания/баннеры; карточки в ленте и поиске — без значков (их много, мешали бы). */
    function wanted(img) {
      return state.imgTr && img.isConnected && !ImgTr.isThumb(img) && ImgTr.eligible(img, Math.min(200, innerWidth * 0.45), 120);
    }

    function mk(img) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tbrub-tap notranslate';
      el.setAttribute('translate', 'no');
      el.textContent = '文';
      let lp = 0, long = false, x0 = 0, y0 = 0;
      const clear = () => { clearTimeout(lp); lp = 0; };
      el.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        long = false; x0 = e.clientX; y0 = e.clientY;
        clear();
        lp = setTimeout(() => { lp = 0; long = true; ImgTr.showFor(img); }, 550);
      }, true);
      el.addEventListener('pointermove', (e) => { if (lp && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) clear(); }, true);
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => el.addEventListener(t, clear, true));
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
      // карусель/ссылка под фото не должна реагировать на нажатие значка
      ['mousedown', 'mouseup', 'touchstart', 'touchend'].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation(), { capture: true, passive: true }));
      el.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (long) { long = false; return; }                 // долгое нажатие уже открыло сервисы
        ImgOcr.toggle(img).then(refresh);
        refresh();
      }, true);
      return el;
    }

    /** Левый верхний угол видимой части фото внутри контейнера (широкий баннер шире контейнера — от края контейнера). */
    function pos(img, b) {
      const host = hostOf(img);
      if (!host) return;
      if (b.el.parentNode !== host) host.appendChild(b.el);
      if (getComputedStyle(host).position === 'static') { host.style.position = 'relative'; b.rel = host; }
      const a = img.getBoundingClientRect(), h = host.getBoundingClientRect();
      if (a.width < 2 || a.height < 2) { b.el.style.display = 'none'; return; }
      b.el.style.display = '';
      b.el.style.left = Math.round(Math.max(a.left, h.left) - h.left - host.clientLeft + host.scrollLeft + 8) + 'px';
      b.el.style.top = Math.round(Math.max(a.top, h.top) - h.top - host.clientTop + host.scrollTop + 8) + 'px';
    }

    function refresh() {
      for (const [img, b] of badges) {
        const st = ImgOcr.busy(img) ? 'busy' : ImgOcr.has(img) ? 'shown' : '';
        if (b.st === st) continue;
        b.st = st;
        b.el.textContent = st === 'busy' ? '⏳' : st === 'shown' ? '↩' : '文';
        b.el.className = 'tbrub-tap notranslate' + (st ? ' ' + st : '');
        b.el.setAttribute('aria-label', st === 'shown' ? 'Показать оригинал' : st === 'busy' ? 'Перевожу текст на фото' : 'Перевести текст на фото');
      }
    }

    function add(img) {
      if (badges.has(img) || !wanted(img)) return;
      const b = { el: mk(img), rel: null, st: null };
      badges.set(img, b);
      pos(img, b);
      refresh();
    }
    function drop(img) {
      const b = badges.get(img);
      if (!b) return;
      b.el.remove();
      if (b.rel && !b.rel.querySelector(':scope > .tbrub-ocr,:scope > .tbrub-tap')) b.rel.style.removeProperty('position');
      badges.delete(img);
    }

    function onIO(entries) {
      for (const e of entries) {
        if (e.isIntersecting) { inView.add(e.target); add(e.target); } else { inView.delete(e.target); drop(e.target); }
      }
    }
    const onLoad = (e) => { const t = e.target; if (t && t.tagName === 'IMG' && inView.has(t)) { add(t); const b = badges.get(t); if (b) pos(t, b); } };

    function scan() {
      if (!io) return;
      for (const img of document.images) { if (!seen.has(img)) { seen.add(img); io.observe(img); } }
      for (const img of Array.from(inView)) {
        if (!img.isConnected) { inView.delete(img); drop(img); continue; }
        if (!badges.has(img)) add(img);                      // догрузилось/выросло — теперь подходит
      }
      for (const [img, b] of Array.from(badges)) {
        if (!wanted(img)) { drop(img); continue; }
        pos(img, b);                                         // контейнер перерисован, фото сдвинулось
      }
    }
    let resizeT = 0;
    const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(scan, 150); };

    function start() {
      if (!MOBILE || io || !state.imgTr || !document.body) return;
      io = new IntersectionObserver(onIO, { rootMargin: '300px 0px 300px 0px' });
      scan();
      timer = setInterval(() => { if (!document.hidden) scan(); }, 1500);
      document.addEventListener('load', onLoad, true);
      window.addEventListener('resize', onResize, { passive: true });
    }
    function stop() {
      if (io) io.disconnect();
      io = null;
      clearInterval(timer);
      document.removeEventListener('load', onLoad, true);
      window.removeEventListener('resize', onResize);
      Array.from(badges.keys()).forEach(drop);
      inView.clear();
      seen = new WeakSet();
    }
    return { start, stop, refresh, scan, count: () => badges.size };
  })();

  /** Телефон, первый раз: как переводить надписи на фото — автоматически, по значку «文» или не нужно. */
  const MobAsk = (() => {
    const MODES = { auto: [true, true], tap: [true, false], off: [false, false] };
    let shown = false, t = 0;
    function apply(mode) {
      const m = MODES[mode] || MODES.tap;
      state.imgTr = m[0]; state.imgAuto = m[1];
      store.set('imgTr', state.imgTr); store.set('imgAuto', state.imgAuto); store.set('photoAsk', mode);
      if (state.imgTr) MobImg.start(); else { MobImg.stop(); ImgOcr.removeAll(); }
      if (state.imgAuto) ImgAuto.start(); else ImgAuto.stop();
      if (state.imgAuto) setTimeout(() => OcrEngines.warmup(), 300);
      Ui.render();
    }
    function bigPhoto() {
      for (const img of document.images) {
        const r = img.getBoundingClientRect();
        if (r.width >= innerWidth * 0.6 && r.height >= 150 && r.bottom > 0 && r.top < innerHeight && !ImgTr.isThumb(img)) return true;
      }
      return false;
    }
    function check() {
      t = 0;
      if (shown || store.get('photoAsk', null) || (!isItemPage() && !bigPhoto())) return;
      const skips = store.get('photoAskSkips', 0) | 0;
      const el = noticeCard('Переводить надписи на фото?',
        'Распознавание идёт прямо в телефоне, фото никуда не отправляются. Один раз скачается ≈ 27 МБ; пока фото переводятся, тратится заряд. ' +
        'Поменять можно в панели TaoNihao → «Перевод».',
        [{ label: 'Автоматически', main: true, fn: () => apply('auto') },
          { label: 'По значку 文', fn: () => apply('tap') },
          { label: 'Не нужно', fn: () => apply('off') }],
        () => { store.set('photoAskSkips', skips + 1); if (skips + 1 >= 3) apply('tap'); });   // трижды закрыли — тихий режим «по значку»
      if (el) shown = true; else t = setTimeout(check, 4000);          // на экране другая подсказка — позже
    }
    function start() {
      if (!MOBILE || store.get('photoAsk', null)) return;
      t = setTimeout(check, 2500);
      window.addEventListener('scroll', () => { if (!shown) { clearTimeout(t); t = setTimeout(check, 700); } }, { passive: true });
    }
    return { start, apply };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  7. SPA: общий MutationObserver с дебаунсом, пересчёт при смене SKU
   * ══════════════════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════════════════
   *  6⅞⁰. ЗАЩИТА ОТ КАПЧИ: увидели проверку Taobao — 15 минут ничего не делаем сами
   *       (автоклики, подгрузка фото, распознавание), только перевод текста и цены.
   * ══════════════════════════════════════════════════════════════════════ */
  const Guard = (() => {
    const SEL = '#baxia-dialog-content,.baxia-dialog,#nocaptcha,.nc-container,.nc_wrapper,iframe[src*="punish"],iframe[src*="captcha"],#J_MIDDLEWARE_FRAME_WIDGET';
    let until = Number(store.get('guardUntil', 0)) || 0;
    function check() {
      const hit = /\/punish|_____tmd_____|captcha/i.test(location.pathname + location.search) || !!document.querySelector(SEL);
      if (hit && Date.now() > until - 14 * 60 * 1000) {
        until = Date.now() + 15 * 60 * 1000;
        store.set('guardUntil', until);
        console.warn('[tb-rub] Taobao показал проверку (капчу) — автоматические действия скрипта на паузе 15 минут');
      }
      return hit;
    }
    return { check, paused: () => Date.now() < until };
  })();

  /* ══════════════════════════════════════════════════════════════════════
   *  6⅞+. ОТЗЫВЫ: «Все отзывы» сразу открываются сеткой фото (кнопка 图集 в шторке)
   * ══════════════════════════════════════════════════════════════════════ */
  const Reviews = (() => {
    const done = new WeakSet();
    let lastOpen = null;
    function check() {
      if (!state.revAlbum || Guard.paused()) return;
      const dr = Array.from(document.querySelectorAll('[class*="Drawer--"]'))
        .find((d) => d.querySelector('[class*="Comments--"]') && d.getBoundingClientRect().width > 200);
      if (!dr) { lastOpen = null; return; }
      if (lastOpen === dr && done.has(dr)) return;
      lastOpen = dr;
      if (done.has(dr)) return;
      const btn = dr.querySelector('[class*="picFliterWrap--"]');
      if (!btn) return;
      done.add(dr);
      if (!dr.querySelector('[class*="commentsImgWrap--"]')) btn.click();
    }
    function reset() { lastOpen = null; }
    return { check, reset, done };
  })();

  /* ══════════════════════════════════════════════════════════════════════
   *  6⅞++. ВЕС ТОВАРА рядом с ценой (из характеристик или названия выбранного варианта)
   * ══════════════════════════════════════════════════════════════════════ */
  const Weight = (() => {
    const W_RE = /(\d+(?:\.\d+)?)\s*(kg|KG|Kg|千克|公斤|斤|克|g)(?![a-zA-Z])/;
    const KEY_RE = /毛重|净重|重量|单重|净含量|商品重/;
    const SKIP_RE = /承重|载重|最大承|承载|负重/;
    const MULT = { kg: 1, KG: 1, Kg: 1, '千克': 1, '公斤': 1, '斤': 0.5, '克': 0.001, g: 0.001 };
    let el = null, lastTxt = '';

    function origText(root) {
      let out = '';
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = tw.nextNode())) if (!n.parentElement.closest(OWN_SEL)) out += Translator.origOf(n) + ' ';
      return out.replace(/\s+/g, ' ');
    }
    function parse(s) {
      const m = W_RE.exec(s);
      if (!m) return null;
      const v = parseFloat(m[1]) * MULT[m[2]];
      return v > 0 && v < 2000 ? v : null;
    }
    function detect() {
      for (const it of document.querySelectorAll('[class*="InfoItem--"],[class*="infoItem--"],[class*="paramsInfoItem"]')) {
        const t = origText(it);
        if (!KEY_RE.test(t) || SKIP_RE.test(t)) continue;
        const v = parse(t.slice(t.search(KEY_RE)));
        if (v) return { v, src: 'характеристики' };
      }
      const sel = document.querySelector('[class*="valueItem"][class*="isSelected"],[class*="valueItem"][class*="selected"],[class*="valueItem"][aria-checked="true"]');
      if (sel) {
        const t = origText(sel);
        if (!SKIP_RE.test(t)) { const v = parse(t); if (v) return { v, src: 'вариант товара' }; }
      }
      return null;
    }
    function host() {
      const list = Array.from(document.querySelectorAll('[class*="priceWrap--"],[class*="PriceWrap--"]'))
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.top + scrollY < 900; });
      return list[0] || null;
    }
    function update() {
      if (!state.showWeight || !isItemPage()) { if (el) { el.remove(); el = null; } return; }
      const w = detect();
      const h = w && host();
      if (!w || !h) { if (el) { el.remove(); el = null; } return; }
      const v = Math.round(w.v * 10) / 10;
      const txt = '⚖ ' + (v < 0.1 ? '< 0,1' : '≈ ' + fmtNum(v, 1)) + ' кг';
      if (!el || !el.isConnected || el.parentElement !== h) {
        if (el) el.remove();
        el = document.createElement('span');
        el.className = 'tbrub-weight notranslate';
        el.setAttribute('translate', 'no');
        h.appendChild(el);
      }
      if (lastTxt !== txt || el.textContent !== txt) { el.textContent = txt; lastTxt = txt; }
      el.title = 'Вес товара (' + w.src + '): ' + fmtNum(w.v, 3).replace(/,?0+$/, '') + ' кг';
    }
    return { update };
  })();

  const OWN_SEL = '#tbrub-root,#tbrub-toast,#tbrub-imgbtn,#tbrub-notice,.tbrub-tap,.tbrub-ocr,.tb-rub,.tbrub-rev,.tbrub-weight';
  const Watch = (() => {
    const zones = new Set();
    const trNodes = new Set();
    let timer = 0, firstAt = 0;
 
    const isOwnNode = (n) => (n.nodeType === 1
      ? (n.classList.contains('tb-rub') || n.id === 'tbrub-root' || n.id === 'tbrub-toast' || n.id === 'tbrub-imgbtn' ||
        n.classList.contains('tbrub-ocr') || n.classList.contains('tbrub-rev') || n.classList.contains('tbrub-weight') ||
        n.classList.contains('tbrub-tap') || n.id === 'tbrub-notice')
      : !!(n.parentElement && n.parentElement.closest(OWN_SEL)));
 
    function isOwn(r) {
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (t && t.closest(OWN_SEL)) return true;
      if (r.type === 'characterData') return Translator.isOwnWrite(r.target);
      const nodes = Array.from(r.addedNodes).concat(Array.from(r.removedNodes));
      return nodes.length > 0 && nodes.every(isOwnNode);
    }
 
    function widen(el) {
      let c = el;
      for (let i = 0; i < 2; i++) {
        const p = c.parentElement;
        if (!p || p === document.body || p === document.documentElement) break;
        c = p;
      }
      return c;
    }
 
    function topmost(list) {
      const s = new Set(list);
      return list.filter((n) => { for (let a = n.parentElement; a; a = a.parentElement) if (s.has(a)) return false; return true; });
    }
 
    function flush() {
      const t0 = performance.now();
      try { flushRaw(); } finally { Perf.add('Изменения страницы', performance.now() - t0); }
    }
    function flushRaw() {
      timer = 0; firstAt = 0;
      Guard.check();
      const z = topmost(Array.from(zones).filter((e) => e.isConnected).map(widen));
      zones.clear();
      if (z.length > 200) Prices.fullScan(); else Prices.scanRoots(z);
      if (state.pageTr) {
        const nodes = Array.from(trNodes);
        trNodes.clear();
        const roots = topmost(nodes.filter((n) => n.isConnected && n.nodeType === 1)).concat(nodes.filter((n) => n.nodeType === 3 && n.isConnected));
        Translator.batch(() => roots.forEach((r) => Translator.scan(r)));
      } else trNodes.clear();
    }
 
    function schedule() {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      clearTimeout(timer);
      timer = setTimeout(flush, Math.min(120, Math.max(0, 400 - (now - firstAt))));
    }
 
    function start() {
      new MutationObserver((records) => {
        let dirty = false;
        for (const r of records) {
          if (isOwn(r)) continue;
          dirty = true;
          if (r.type === 'characterData') {
            if (r.target.parentElement) zones.add(r.target.parentElement);
            trNodes.add(r.target);
          } else {
            zones.add(r.target);
            r.addedNodes.forEach((n) => { if (!isOwnNode(n)) { trNodes.add(n); if (n.nodeType === 1) zones.add(n); } });
          }
        }
        if (dirty) schedule();
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
 
      // Клик по варианту SKU: цена обновляется асинхронно → быстрые перепроверки
      document.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('#SkuPanel_tbpcDetail_ssr2025,[class*="sku" i],[class*="valueItem" i]')) {
          [40, 200, 600, 1400].forEach((ms) => setTimeout(() => { Prices.fullScan(); Weight.update(); }, ms));
        }
      }, true);
      window.addEventListener('pageshow', () => setTimeout(() => Prices.fullScan(), 200));
      // изменения ловит MutationObserver; полный проход — редкая страховка
      setInterval(() => { if (!document.hidden) Prices.fullScan(); }, 10000);
      setInterval(() => { if (!document.hidden) { Weight.update(); Reviews.check(); } }, 1500);
    }
 
    return { start };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  8. ВИДЖЕТ: плашка курса + всплывающая панель настроек
   * ══════════════════════════════════════════════════════════════════════ */
  const AHEAD_NAMES = ['Экран', 'Бережно', 'Быстро', 'Макс'];
  const AHEAD_HINTS = [
    'Только то, что на экране. Меньше всего нагрузки; при прокрутке перевод появляется через 1–2 с.',
    'Видимое — всеми потоками, ниже по странице — одним, с паузой во время прокрутки (~3 экрана вперёд).',
    'Заранее — всеми потоками, пауза во время прокрутки (~6 экранов вперёд).',
    'Всё сразу всеми потоками, без пауз (~6 экранов вперёд). Быстрее всего, процессор занят полностью.'
  ];

  const Ui = (() => {
    let els = null;
    let statusTimer = 0;
 
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const btn = (text, onClick, cls) => {
      const b = mk('button', cls || 'tbrub-b', text);
      b.type = 'button';
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
      return b;
    };
    const toggle = (onClick) => btn('', onClick, 'tbrub-t');
    /** Значок «?» — длинное пояснение во всплывающей подсказке вместо текста в панели. */
    const help = (text) => {
      const q = mk('span', 'tbrub-q', '?');
      q.title = text; q.tabIndex = 0;
      // на телефоне всплывающих подсказок (title) нет — показываем текст по нажатию
      if (MOBILE) q.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); toast(q.title, 9000); });
      return q;
    };
    const lab = (text, helpText) => { const s = mk('span', 'tbrub-lab'); s.appendChild(document.createTextNode(text)); if (helpText) s.appendChild(help(helpText)); return s; };
    /** Сворачиваемый раздел; что открыто — запоминается. */
    const openState = (() => { const o = store.get('uiOpen', null); return o && typeof o === 'object' ? o : {}; })();
    function section(id, title, defOpen, nodes) {
      const sec = mk('div', 'tbrub-sec');
      const h = mk('button', 'tbrub-hbtn');
      h.type = 'button';
      h.append(mk('span', 'tbrub-chev', '▾'), mk('span', '', title));
      const body = mk('div', 'tbrub-body');
      body.append(...nodes);
      const isOpen = () => (id in openState ? !!openState[id] : defOpen);
      const apply = () => { body.hidden = !isOpen(); sec.classList.toggle('closed', !isOpen()); };
      h.addEventListener('click', (e) => { e.stopPropagation(); openState[id] = !isOpen(); store.set('uiOpen', openState); apply(); render(); });
      sec.append(h, body);
      apply();
      return sec;
    }
    /** Пресеты: Тихий / Баланс / Быстрый. Любая ручная правка — «Свой». */
    function presetCfg(k) {
      const p = CpuInfo.plan();
      return {
        quiet: { t: 1, a: 0, b: true },
        balance: { t: 0, a: 1, b: true },
        fast: { t: p.phys === p.opt ? 0 : p.phys, a: 2, b: false }
      }[k];
    }
    function applyPreset(k) {
      const c = presetCfg(k);
      state.ocrThreads = c.t; state.imgAhead = c.a; state.thumbBig = c.b;
      store.set('ocrThreads', c.t); store.set('imgAhead', c.a); store.set('thumbBig', c.b);
      ImgAuto.restart(); OcrEngines.poolPump(); ImgAuto.pump(); render();
    }
    function currentPreset() {
      const p = CpuInfo.plan();
      for (const k of ['quiet', 'balance', 'fast']) {
        const c = presetCfg(k);
        const kk = c.t > 0 ? Math.min(c.t, p.max) : p.opt;
        if (p.k === kk && state.imgAhead === c.a && state.thumbBig === c.b) return k;
      }
      return '';
    }
 
    function mount() {
      if (document.getElementById('tbrub-root') || !document.body) return;
      const root = mk('div', 'notranslate');
      root.id = 'tbrub-root';
      root.setAttribute('translate', 'no');
      if (MOBILE) { root.classList.add('mob'); document.documentElement.classList.add('tbrub-mob'); }
 
      const pill = mk('button', 'tbrub-pill');
      pill.type = 'button';
      const dot = mk('span', 'tbrub-dot');
      const pillRate = mk('span', '');
      const pillTr = mk('span', 'tbrub-tag', '文');
      const pillWork = mk('span', 'tbrub-work');
      pillWork.hidden = true;
      pill.append(dot, pillRate, pillWork, pillTr);
 
      const panel = mk('div', 'tbrub-panel');
      panel.hidden = true;
      panel.addEventListener('click', (e) => e.stopPropagation());
 
      // курс
      const sRate = mk('div');
      const big = mk('div', 'tbrub-big');
      const src = mk('div', 'tbrub-sub');
      const rateRow = mk('div', 'tbrub-row');
      const bAuto = btn('Авто', () => {
        state.auto = true; state.cnyAutoOn = true;
        store.set('auto', true); store.set('cnyAutoOn', true);
        syncRates(true);
      });
      const bManual = btn('Вручную…', () => {
        const v = window.prompt('Ручной курс: сколько ₽ за 1 ¥?', String(state.manualRate));
        if (v === null) return;
        const r = sanitizeRate(v);
        if (!r) { window.alert('Некорректный курс. Пример: 12.25'); return; }
        state.manualRate = r; state.auto = false;
        store.set('rate', r); store.set('auto', false);
        applyRate();
      });
      const bCny = btn('¥ за USDT…', () => {
        const v = window.prompt('Сколько ¥ даёт 1 USDT? Число — зафиксировать, «auto» — брать из P2P/форекса.',
          state.cnyAutoOn ? 'auto' : String(state.usdtCnyManual));
        if (v === null) return;
        if (/^\s*(auto|авто)\s*$/i.test(v)) { state.cnyAutoOn = true; store.set('cnyAutoOn', true); syncRates(true); return; }
        const r = sanitizeRate(v);
        if (!r || r > 100) { window.alert('Некорректное значение. Пример: 7.2'); return; }
        state.usdtCnyManual = r; state.cnyAutoOn = false; state.auto = true;
        store.set('usdtCny', r); store.set('cnyAutoOn', false); store.set('auto', true);
        syncRates(false);
      });
      const bRefresh = btn('⟳', () => syncRates(true));
      bRefresh.title = 'Обновить курсы сейчас';
      rateRow.append(bAuto, bManual, bCny, bRefresh);
      sRate.append(mk('div', 'tbrub-h', 'Курс'), big, src, rateRow);
 
      // режим цен
      const sMode = mk('div');
      const modeRow = mk('div', 'tbrub-row');
      const setMode = (m) => { state.mode = m; store.set('mode', m); render(); Prices.fullScan(); };
      const bBeside = btn('Рядом: ¥ + ₽', () => setMode('beside'));
      const bReplace = btn('Замена: только ₽', () => setMode('replace'));
      modeRow.append(bBeside, bReplace);
      sMode.append(mk('div', 'tbrub-h', 'Цены'), modeRow);
 
      // перевод
      const sTr = mk('div');
      const rowPage = mk('div', 'tbrub-sw');
      const tPage = toggle(() => {
        state.pageTr = !state.pageTr;
        store.set('pageTr', state.pageTr);
        if (state.pageTr) Translator.start(); else Translator.stop();
        render();
      });
      rowPage.append(lab('Перевод страницы (Google, 中→RU)', 'Перевод идёт через Google Translate.\nБез входа в аккаунт Google он чаще отказывает (ошибки 429, «подозрительный трафик») — войдите в Google в этом браузере, лимиты выше.'), tPage);
      const trStatus = mk('div', 'tbrub-sub');
      const rowSearch = mk('div', 'tbrub-sw');
      const tSearch = toggle(() => { state.searchTr = !state.searchTr; store.set('searchTr', state.searchTr); render(); });
      rowSearch.append(mk('span', '', 'Перевод поиска RU/EN → 中文'), tSearch);
      const rowImg = mk('div', 'tbrub-sw');
      const tImg = toggle(() => {
        state.imgTr = !state.imgTr; store.set('imgTr', state.imgTr);
        if (MOBILE) store.set('photoAsk', 'custom');
        if (!state.imgTr) { ImgTr.hide(); ImgOcr.removeAll(); ImgAuto.stop(); MobImg.stop(); } else { ImgAuto.start(); MobImg.start(); }
        render();
      });
      rowImg.append(mk('span', '', MOBILE ? 'Перевод на фото (значок 文 на фото)' : 'Перевод на картинках (кнопки при наведении)'), tImg);
      const rowRev = mk('div', 'tbrub-sw');
      const tRev = toggle(() => { state.revWhole = !state.revWhole; store.set('revWhole', state.revWhole); Translator.resetReviews(); render(); });
      rowRev.append(mk('span', '', 'Отзыв переводить целиком'), tRev);
      const rowAlbum = mk('div', 'tbrub-sw');
      const tAlbum = toggle(() => { state.revAlbum = !state.revAlbum; store.set('revAlbum', state.revAlbum); Reviews.reset(); render(); });
      rowAlbum.append(mk('span', '', 'Все отзывы — сразу фото сеткой'), tAlbum);
      const rowWeight = mk('div', 'tbrub-sw');
      const tWeight = toggle(() => { state.showWeight = !state.showWeight; store.set('showWeight', state.showWeight); Weight.update(); render(); });
      rowWeight.append(mk('span', '', 'Вес товара рядом с ценой'), tWeight);
      const rowSame = mk('div', 'tbrub-sw');
      const tSame = toggle(() => {
        state.sameTab = !state.sameTab; store.set('sameTab', state.sameTab);
        document.documentElement.setAttribute('data-tbrub-sametab', state.sameTab ? '1' : '0');
        render();
      });
      rowSame.append(mk('span', '', 'Товары открывать в этой же вкладке'), tSame);
 
      // фото: движок распознавания и автоперевод
      const sImg = mk('div');
      const rowEng = mk('div', 'tbrub-row');
      const engBtns = {};
      [['auto', 'Авто'], ['paddle', 'Paddle'], ['tesseract', 'Tesseract'], ['vision', 'Vision 🔑']].forEach(([k, label]) => {
        engBtns[k] = btn(label, () => {
          state.ocrEngine = k; store.set('ocrEngine', k);
          if (k === 'vision' && !state.visionKey) ImgOcr.askKey();
          OcrEngines.warmup();
          render();
        });
      });
      engBtns.auto.title = 'PaddleOCR → при сбое Tesseract → Google Vision (если задан ключ; в автопереводе Vision не используется)';
      engBtns.paddle.title = 'PaddleOCR (Baidu) прямо в браузере, без ключей: лучшее качество на китайском. ≈27 МБ, качается один раз';
      engBtns.tesseract.title = 'Tesseract прямо в браузере, без ключей: ≈5 МБ, быстрее грузится, хуже на рекламных шрифтах';
      engBtns.vision.title = 'Google Cloud Vision: нужен ключ API (1000 картинок в месяц бесплатно)';
      Object.values(engBtns).forEach((b) => rowEng.appendChild(b));
      const rowAuto = mk('div', 'tbrub-sw');
      const tAuto = toggle(() => {
        state.imgAuto = !state.imgAuto; store.set('imgAuto', state.imgAuto);
        if (MOBILE) store.set('photoAsk', 'custom');
        if (state.imgAuto) ImgAuto.start(); else ImgAuto.stop();
        render();
      });
      rowAuto.append(mk('span', '', 'Автоперевод фото'), tAuto);
      const rowThumbs = mk('div', 'tbrub-sw');
      const tThumbs = toggle(() => { state.imgThumbs = !state.imgThumbs; store.set('imgThumbs', state.imgThumbs); render(); });
      rowThumbs.append(mk('span', '', 'Фото в карточках товаров (поиск, лента)'), tThumbs);
      const rowThumbBig = mk('div', 'tbrub-sw');
      const tThumbBig = toggle(() => { state.thumbBig = !state.thumbBig; store.set('thumbBig', state.thumbBig); render(); });
      rowThumbBig.append(lab('Миниатюры: только крупный текст', 'Строки, которые на миниатюре мельче 9px, не распознаются — их всё равно не прочесть.\nЭкономит ~20–25% работы на миниатюрах. На странице товара фото переводятся целиком.'), tThumbBig);

      // перевод фото заранее — 4 уровня
      const aheadLbl = mk('div', 'tbrub-sw');
      const aheadVal = mk('span', 'tbrub-val');
      const aheadHint = help('');
      aheadLbl.append(lab('Перевод фото заранее'), aheadVal);
      aheadLbl.firstChild.appendChild(aheadHint);
      const aheadRange = mk('input', 'tbrub-range');
      aheadRange.type = 'range'; aheadRange.min = '0'; aheadRange.max = '3'; aheadRange.step = '1';
      aheadRange.addEventListener('click', (e) => e.stopPropagation());
      aheadRange.addEventListener('input', () => { state.imgAhead = +aheadRange.value; renderAhead(); });
      aheadRange.addEventListener('change', () => { store.set('imgAhead', state.imgAhead); ImgAuto.restart(); render(); });
      const aheadTicks = mk('div', 'tbrub-ticks');
      AHEAD_NAMES.forEach((n) => aheadTicks.appendChild(mk('span', '', n)));
      const aheadBox = mk('div');
      aheadBox.append(aheadLbl, aheadRange, aheadTicks);

      // нагрузка на процессор — единый ползунок (потоки распознавания по замеру процессора)
      const sCpu = mk('div');
      const cpuLbl = mk('div', 'tbrub-sw');
      const cpuVal = mk('span', 'tbrub-val');
      cpuLbl.append(lab('Нагрузка на процессор', 'Сколько процессора плагин может занять, пока распознаёт фото (в простое — 0%).\n' +
        'Зелёная зона — высокий КПД, жёлтая — быстрее ценой КПД, красная — гиперпотоки: нагрузка растёт, скорость почти нет.\n' +
        'Каждый поток — ещё ~150 МБ памяти; через минуту без работы память освобождается.'), cpuVal);
      const cpuRange = mk('input', 'tbrub-range');
      cpuRange.type = 'range'; cpuRange.min = '1'; cpuRange.step = '1';
      cpuRange.addEventListener('click', (e) => e.stopPropagation());
      cpuRange.addEventListener('input', () => {
        const p = CpuInfo.plan(), k = +cpuRange.value;
        state.ocrThreads = k === p.opt ? 0 : k;         // ровно оптимум — «авто»: на другом ПК подстроится сам
        renderCpu();
      });
      cpuRange.addEventListener('change', () => { store.set('ocrThreads', state.ocrThreads); OcrEngines.poolPump(); ImgAuto.pump(); render(); });
      const cpuCap = mk('div', 'tbrub-sub');
      const cpuRow = mk('div', 'tbrub-row');
      const bCpuOpt = btn('Оптимум', () => { state.ocrThreads = 0; store.set('ocrThreads', 0); OcrEngines.poolPump(); ImgAuto.pump(); render(); });
      bCpuOpt.title = 'Половина физических ядер: лучший баланс скорости и КПД';
      cpuRow.append(bCpuOpt);
      const rowGpu = mk('div', 'tbrub-sw');
      const tGpu = toggle(() => {
        state.ocrGpu = !state.ocrGpu; store.set('ocrGpu', state.ocrGpu);
        if (state.ocrGpu) OcrEngines.gpuRetry();          // включили снова — дать видеокарте ещё попытку
        OcrEngines.poolPump(); ImgAuto.pump(); render();
      });
      rowGpu.append(lab('Видеокарта (WebGPU)', 'Распознавание на видеокарте: то же качество, процессор почти не нагружается. Один раз скачивается ~19 МБ.\n' +
        'Дискретная (NVIDIA) — главный движок: фото ≈ 0,3 с, процессор помогает только с очередью; включается сама, если вы её не выключали.\n' +
        'Встроенная — дополнительный поток. Не поддерживается — работает только процессор.'), tGpu);
      const gpuNote = mk('div', 'tbrub-sub');
      const poolLine = mk('div', 'tbrub-sub');
      poolLine.style.whiteSpace = 'pre-line';
      const engStatus = mk('div', 'tbrub-sub');
      const rowKey = mk('div', 'tbrub-sw');
      const keyInfo = mk('span', '', '');
      const bKey = btn('Ключ…', () => ImgOcr.askKey());
      rowKey.append(keyInfo, bKey);
      const perfLine = mk('div', 'tbrub-sub');
      perfLine.style.whiteSpace = 'pre-line';

      // кэш на этом сайте (как в Telegram): лимит ползунком + точное число, срок хранения, очистка
      const CMIN = 50, CMAX = 5120;
      const mbToPos = (mb) => Math.round((Math.log(mb / CMIN) / Math.log(CMAX / CMIN)) * 1000);
      const posToMb = (pos) => {
        const v = CMIN * Math.pow(CMAX / CMIN, pos / 1000);
        return v < 200 ? Math.round(v / 5) * 5 : v < 1024 ? Math.round(v / 10) * 10 : Math.round(v / 64) * 64;
      };
      const cacheInfo = mk('div', 'tbrub-sub');
      const cacheLbl = mk('div', 'tbrub-sw');
      const cacheNum = mk('input', 'tbrub-num');
      cacheNum.type = 'number'; cacheNum.min = String(CMIN); cacheNum.max = String(CMAX); cacheNum.step = '1';
      const cacheNumBox = mk('span', 'tbrub-numbox');
      cacheNumBox.append(cacheNum, mk('span', '', 'МБ'));
      cacheLbl.append(lab('Лимит кэша', 'Распознанные фото и модели распознавания на этом сайте Taobao/Tmall (у каждого сайта — свой кэш).\n' +
        'Сверх лимита удаляется самое старое распознанное; модели не удаляются, но учитываются. Одно фото ≈ 1–2 КБ.'), cacheNumBox);
      const cacheRange = mk('input', 'tbrub-range');
      cacheRange.type = 'range'; cacheRange.min = '0'; cacheRange.max = '1000'; cacheRange.step = '1';
      const setCache = (mb, save) => {
        mb = Math.min(CMAX, Math.max(CMIN, Math.round(mb) || 200));
        state.cacheMB = mb;
        cacheNum.value = String(mb);
        cacheRange.value = String(mbToPos(mb));
        if (save) { store.set('cacheMB', mb); OcrStore.schedulePrune(1500); renderCache(true); }
      };
      const stop = (e) => e.stopPropagation();
      cacheRange.addEventListener('click', stop);
      cacheRange.addEventListener('input', () => setCache(posToMb(+cacheRange.value), false));
      cacheRange.addEventListener('change', () => setCache(state.cacheMB, true));
      ['click', 'keydown', 'keyup', 'keypress', 'input'].forEach((t) => cacheNum.addEventListener(t, stop));   // Taobao не должен ловить ввод
      cacheNum.addEventListener('change', () => setCache(+cacheNum.value, true));
      const cacheTicks = mk('div', 'tbrub-ticks');
      ['50 МБ', '200 МБ', '1 ГБ', '5 ГБ'].forEach((t) => cacheTicks.appendChild(mk('span', '', t)));
      const ttlRow = mk('div', 'tbrub-row');
      const ttlBtns = {};
      ttlRow.appendChild(lab('Хранить:'));
      [['week', 'Неделю'], ['month', 'Месяц'], ['quarter', '3 месяца'], ['forever', 'Всегда']].forEach(([k, l]) => {
        ttlBtns[k] = btn(l, () => { state.cacheTTL = k; store.set('cacheTTL', k); OcrStore.schedulePrune(1500); render(); renderCache(true); });
        ttlRow.appendChild(ttlBtns[k]);
      });
      const cacheBtns = mk('div', 'tbrub-row');
      cacheBtns.append(
        btn('Очистить распознанное', async () => {
          if (!window.confirm('Удалить все распознанные фото на этом сайте? При просмотре они распознаются заново.')) return;
          await OcrStore.clear(); renderCache(true);
        }),
        btn('Удалить модели', async () => {
          if (!window.confirm('Удалить скачанные модели распознавания на этом сайте? Они скачаются заново при следующем фото.')) return;
          await OcrEngines.deleteModels(); renderCache(true);
        }));
      setCache(state.cacheMB, false);

      // пресеты
      const presetRow = mk('div', 'tbrub-row tbrub-presets');
      const presetBtns = {};
      [['quiet', 'Тихий'], ['balance', 'Баланс'], ['fast', 'Быстрый']].forEach(([k, l]) => {
        presetBtns[k] = btn(l, () => applyPreset(k));
        presetRow.appendChild(presetBtns[k]);
      });
      const presetNote = mk('span', 'tbrub-sub');
      presetRow.append(presetNote, help('Тихий — 1 поток, перевод фото только на экране, миниатюры — крупный текст.\n' +
        'Баланс — оптимум потоков (½ физических ядер), фото заранее «Бережно».\n' +
        'Быстрый — все физические ядра, «Быстро», миниатюры целиком.\nЛюбая ручная настройка ниже — режим «Свой».'));

      const rowVideo = mk('div', 'tbrub-sw');
      const tVideo = toggle(() => { state.noThumbVideo = !state.noThumbVideo; store.set('noThumbVideo', state.noThumbVideo); render(); });
      rowVideo.append(lab('Не проигрывать видео на миниатюрах', 'Taobao запускает видео товара при наведении на карточку. Выключение экономит трафик и процессор.\n' +
        'Пока видео идёт, перевод надписей на фото всё равно прячется, чтобы не висеть поверх кадров.'), tVideo);
      const rowEngLbl = mk('div', 'tbrub-sw');
      rowEngLbl.append(lab('Движок распознавания', (MOBILE ? 'Значок «文» слева вверху на фото: нажатие — перевод, долгое нажатие — Google Lens, Яндекс, 1688.\n'
        : 'Наведите на фото → оранжевый значок «文» слева вверху.\n') + 'Paddle и Tesseract работают прямо в браузере, без ключей и без отправки фото на сервер.\n' +
        'Vision — облако Google, нужен ключ. Значки Google Lens, Яндекс и 1688 открывают фото во внешнем сервисе.'));

      const brand = mk('div', 'tbrub-brand');
      const bn = mk('b');
      bn.append(document.createTextNode('Tao'), mk('i', '', 'Nihao'));
      brand.append(bn, mk('span', '', 'свой среди чужих · 淘你好'));
      panel.append(
        brand,
        presetRow,
        section('rate', 'Курс', true, [big, src, rateRow]),
        section('prices', 'Цены', true, [modeRow, rowWeight, rowSame]),
        section('tr', 'Перевод', true, [rowPage, trStatus, rowSearch, rowImg, rowRev, rowAlbum]),
        section('img', 'Текст на фото', false, [engStatus, rowAuto, aheadBox, rowThumbs, rowThumbBig]),
        section('cpu', 'Производительность', false, [cpuLbl, cpuRange, cpuCap, cpuRow, poolLine]),
        section('adv', 'Дополнительно', false, [
          rowEngLbl, rowEng, rowKey, rowGpu, gpuNote, rowVideo,
          mk('div', 'tbrub-h2', 'Кэш'), cacheLbl, cacheRange, cacheTicks, ttlRow, cacheInfo, cacheBtns,
          mk('div', 'tbrub-h2', 'Нагрузка за минуту'), perfLine,
          mk('div', 'tbrub-ver', 'TaoNihao ' + SCRIPT_VERSION)
        ]));
      const back = mk('div', 'tbrub-back');              // телефон: затемнение под шторкой, нажатие — закрыть
      back.hidden = true;
      const grip = mk('div', 'tbrub-grip');              // телефон: «ручка» шторки, нажатие — закрыть
      panel.prepend(grip);
      const setOpen = (open) => {
        panel.hidden = !open; back.hidden = !open;
        if (open) { renderStatus(); renderCache(true); }
      };
      pill.addEventListener('click', (e) => { e.stopPropagation(); setOpen(panel.hidden); });
      back.addEventListener('click', (e) => { e.stopPropagation(); setOpen(false); });
      grip.addEventListener('click', (e) => { e.stopPropagation(); setOpen(false); });
      document.addEventListener('click', () => { if (!panel.hidden) setOpen(false); });
 
      root.append(back, panel, pill);
      document.body.appendChild(root);
      els = { tSame, perfLine, tThumbs, tRev, tAlbum, tWeight, dot, pillRate, pillTr, pillWork, big, src, bAuto, bManual, bCny, bBeside, bReplace, tPage, tSearch, tImg, trStatus, panel, keyInfo,
        engBtns, tAuto, engStatus, tThumbBig, aheadRange, aheadVal, aheadTicks, aheadHint, cpuRange, cpuVal, cpuCap, bCpuOpt, tGpu, gpuNote, poolLine,
        presetBtns, presetNote, ttlBtns, cacheInfo, cacheNum, cacheRange, setCache, tVideo };
      render();
    }

    let cacheT = 0, cacheBusy = false;
    const fmtBytes = (b) => (b >= 1073741824 ? fmtNum(b / 1073741824, 2) + ' ГБ' : b >= 1048576 ? fmtNum(b / 1048576, b < 10485760 ? 1 : 0) + ' МБ'
      : fmtNum(Math.max(0, b) / 1024, 0) + ' КБ');
    async function renderCache(force) {
      if (!els || els.panel.hidden || cacheBusy || (!force && Date.now() - cacheT < 3000)) return;
      cacheBusy = true; cacheT = Date.now();
      try {
        const [st, models] = await Promise.all([OcrStore.stats(), OcrEngines.modelsSize()]);
        const lim = state.cacheMB * 1048576;
        els.cacheInfo.textContent = 'Занято: ' + fmtBytes(st.bytes + models) + ' из ' + fmtBytes(lim) +
          ' · фото: ' + fmtNum(st.n, 0) + ' (' + fmtBytes(st.bytes) + ') · модели: ' + fmtBytes(models) +
          (models > lim ? ' · ⚠ лимит меньше моделей — распознанное не хранится' : '');
      } catch (_) { /* не важно */ } finally { cacheBusy = false; }
    }

    function render() {
      if (!els) return;
      const live = state.auto && state.usdtRub > 0;
      const stale = state.rubError || (state.cnyAutoOn && state.cnyError);
      els.dot.className = 'tbrub-dot' + (live ? (stale ? ' stale' : ' ok') : '');
      els.pillRate.textContent = '1 ¥ ≈ ' + fmtNum(state.rate, 2) + ' ₽';
      els.big.textContent = '1 ¥ ≈ ' + fmtNum(state.rate, 2) + ' ₽';
      if (live) {
        const t = new Date(Math.max(state.usdtRubTs, state.cnyTs)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const cny = state.cnyAutoOn && state.cnyAuto > 0 ? state.cnySrc : 'задано вручную';
        els.src.textContent = 'Rapira USDT/RUB ' + fmtNum(state.usdtRub, 2) + ' ÷ ' + fmtNum(usdtCnyEff(), 2) +
          ' ¥/USDT (' + cny + ') · ' + t + (stale ? ' · часть источников недоступна' : '');
      } else {
        els.src.textContent = state.auto ? 'Автокурс ещё не получен — используется ручной ' + fmtNum(state.manualRate, 2) : 'Ручной курс';
      }
      els.bAuto.classList.toggle('sel', state.auto && state.cnyAutoOn);
      els.bManual.classList.toggle('sel', !state.auto);
      els.bCny.classList.toggle('sel', state.auto && !state.cnyAutoOn);
      els.bBeside.classList.toggle('sel', state.mode === 'beside');
      els.bReplace.classList.toggle('sel', state.mode === 'replace');
      els.tPage.classList.toggle('on', state.pageTr);
      els.tSearch.classList.toggle('on', state.searchTr);
      els.tImg.classList.toggle('on', state.imgTr);
      els.keyInfo.textContent = 'Ключ Google Vision: ' + (state.visionKey ? 'задан ✓' : 'не задан (не обязателен)');
      Object.keys(els.engBtns).forEach((k) => els.engBtns[k].classList.toggle('sel', state.ocrEngine === k));
      els.tAuto.classList.toggle('on', state.imgAuto);
      els.tRev.classList.toggle('on', state.revWhole);
      els.tThumbs.classList.toggle('on', state.imgThumbs);
      els.tSame.classList.toggle('on', state.sameTab);
      els.tAlbum.classList.toggle('on', state.revAlbum);
      els.tWeight.classList.toggle('on', state.showWeight);
      els.tThumbBig.classList.toggle('on', state.thumbBig);
      els.tGpu.classList.toggle('on', state.ocrGpu);
      els.tVideo.classList.toggle('on', state.noThumbVideo);
      const pre = currentPreset();
      Object.keys(els.presetBtns).forEach((k) => els.presetBtns[k].classList.toggle('sel', pre === k));
      els.presetNote.textContent = pre ? '' : 'Свой';
      Object.keys(els.ttlBtns).forEach((k) => els.ttlBtns[k].classList.toggle('sel', state.cacheTTL === k));
      if (document.activeElement !== els.cacheNum) els.setCache(state.cacheMB, false);
      const pw = OcrEngines.pool();
      const work = pw.cpuBusy + (pw.gpuBusy ? 1 : 0) + pw.queue;
      els.pillWork.hidden = !work;
      els.pillWork.textContent = '🖼 ' + work;
      els.pillWork.title = 'Распознаётся фото: ' + work;
      els.aheadRange.value = String(state.imgAhead);
      renderAhead();
      renderCpu();
      els.engStatus.textContent = OcrEngines.describe();
      els.pillTr.classList.toggle('on', state.pageTr);
      els.pillTr.title = state.pageTr ? 'Перевод страницы включён' : 'Перевод страницы выключен';
      renderStatus();
    }
 
    function renderAhead() {
      if (!els) return;
      const i = state.imgAhead;
      els.aheadVal.textContent = AHEAD_NAMES[i];
      Array.from(els.aheadTicks.children).forEach((t, j) => t.classList.toggle('sel', j === i));
      els.aheadHint.title = AHEAD_NAMES.map((n, j) => (j === i ? '▶ ' : '   ') + n + ' — ' + AHEAD_HINTS[j]).join('\n');
    }

    const secs = (ms) => fmtNum(ms / 1000, ms < 10000 ? 1 : 0);
    /** Ползунок «Нагрузка на процессор»: зоны КПД, потоки, оценка скорости. */
    function renderCpu() {
      if (!els || els.panel.hidden) return;
      const p = CpuInfo.plan(), r = els.cpuRange;
      r.max = String(p.max);
      r.disabled = p.max <= 1;
      if (+r.value !== p.k) r.value = String(p.k);
      const k = p.k;
      const at = (v) => (p.max > 1 ? Math.max(0, Math.min(100, ((v - 1) / (p.max - 1)) * 100)) : 100);
      const a = at(p.opt + 0.5).toFixed(1), b = at(p.phys + 0.5).toFixed(1);
      r.style.background = 'linear-gradient(90deg,#3ddc84 0%,#3ddc84 ' + a + '%,#ffb020 ' + a + '%,#ffb020 ' + b + '%,#e5484d ' + b + '%,#e5484d 100%)';
      const m = CpuInfo.model(k, p.P);
      els.cpuVal.textContent = 'до ' + Math.round((100 * k) / p.L) + '%';
      const pi = OcrEngines.pool();
      // время на фото: замер в потоках, пересчитанный на выбранное число потоков по модели КПД
      const base1 = pi.speedCpu > 0 ? pi.speedCpu * CpuInfo.model(Math.max(1, pi.cpu || k), p.P).eff : 0;
      els.cpuCap.textContent = k + ' ' + plural(k, 'поток', 'потока', 'потоков') + ' из ' + p.L + ' (физ. ядер ≈ ' + p.P + ')' +
        ' · КПД ≈ ' + Math.round(m.eff * 100) + '%' +
        (base1 ? ' · ≈ ' + secs(base1 / m.eff) + ' с на фото, ' + fmtNum((k * m.eff * 1000) / base1, 1) + ' фото/с' : '') +
        (k === p.opt ? ' · оптимум' : k > p.phys ? ' · ⚠ гиперпотоки: низкий КПД' : k > p.opt ? ' · быстрее, КПД ниже' : ' · экономно');
      els.bCpuOpt.classList.toggle('sel', state.ocrThreads === 0);
      const gname = OcrEngines.gpuInfo();
      const integrated = /amd|intel/i.test(gname || '') && !/nvidia/i.test(gname || '');
      els.gpuNote.textContent = !navigator.gpu ? 'Видеокарта: браузер не поддерживает WebGPU.'
        : pi.gpuFailed ? 'Видеокарта недоступна: ' + pi.gpuFailed + ' — работает только процессор.'
          : state.ocrGpu ? 'Видеокарта ' + (pi.gpu ? (pi.gpuBusy ? 'распознаёт' : 'готова') : 'подключится при первом фото') +
            (OcrEngines.gpuPrimary() ? ' · главный движок' : '') +
            (pi.speedGpu > 0 ? ' · ≈ ' + secs(pi.speedGpu) + ' с на фото' : '') +
            (gname ? ' · ' + gname + (integrated ? ' — если в ноутбуке есть дискретная (NVIDIA/AMD), Chrome по умолчанию берёт встроенную: ' +
              'Параметры Windows → Дисплей → Графика → Chrome → «Высокая производительность», затем перезапустить Chrome' : '') : '')
          : (gname ? 'Видеокарта для WebGPU: ' + gname : '');
      const st = ImgAuto.stats();
      const q = st.vis + st.ahead + pi.queue;
      els.poolLine.textContent = pi.sleeping && !pi.cpu ? 'Сейчас: распознавание спит — память освобождена (запуск ≈ 1 с)'
        : !pi.cpu && !pi.gpu ? 'Сейчас: распознавание не запущено'
          : 'Сейчас: потоков ' + pi.cpu + (pi.gpu ? ' + видеокарта' : '') + ', заняты ' + (pi.cpuBusy + (pi.gpuBusy ? 1 : 0)) +
            (pi.mem > 0 ? ' · память ≈ ' + pi.mem + ' МБ' : '') +
            '\nОчередь: ' + (q ? st.vis + ' на экране, ' + st.ahead + ' заранее' : 'пусто') +
            (pi.n ? ' · в среднем ' + secs(pi.speedCpu || pi.speedGpu) + ' с на фото' : '');
    }

    function renderStatus() {
      if (!els || els.panel.hidden || statusTimer) return;
      statusTimer = setTimeout(() => {
        statusTimer = 0;
        renderCpu();
        renderCache(false);
        els.engStatus.textContent = OcrEngines.describe();
        const ps = Perf.summary();
        els.perfLine.textContent = Object.keys(ps).length
          ? Object.entries(ps).map(([k, v]) => k + ': ' + v.ms + ' мс (' + v.n + ' раз)').join('\n') +
            (Guard.paused() ? '\n⏸ Taobao показал капчу — автодействия на паузе' : '')
          : 'пока нет данных';
        const s = Translator.status();
        els.trStatus.textContent = !state.pageTr ? 'Выключен — страница в оригинале'
          : !s.active ? 'Запустится после загрузки страницы'
            : 'Переведено фраз: ' + s.done + (s.queue ? ' · в очереди ' + s.queue : '') + (s.errors ? ' · ошибок сети ' + s.errors : '');
      }, 300);
    }
 
    return { mount, render, renderStatus };
  })();
 
  /* ══════════════════════════════════════════════════════════════════════
   *  9. ЗАПУСК
   * ══════════════════════════════════════════════════════════════════════ */
  addStyle(CSS);
  Search.install();                                   // перехват поиска — раньше скриптов страницы
  installOpenGuard();                                 // window.open страницы → эта же вкладка (если включено)
  if (state.pageTr) {                                 // не даём встроенному переводчику браузера вмешиваться
    whenRoot(() => {
      document.documentElement.setAttribute('translate', 'no');
      document.documentElement.classList.add('notranslate');
    });
  }
 
  /** Ссылки Taobao на товар/главную по умолчанию открываются в новой вкладке — открываем в этой же. */
  /** Страница сама открывает товар/поиск через window.open (карточки без ссылки) — перехватываем в контексте страницы.
   *  Включено ли «в этой вкладке», страница узнаёт из атрибута data-tbrub-sametab на <html>. */
  /* Карточки без ссылок открываются скриптом страницы через window.open — перехватываем в контексте страницы.
   * Свойство window.open заменяем на геттер/сеттер: если скрипт Alibaba позже «обернёт» window.open своей функцией,
   * она станет внутренней (inner), а первым всё равно вызовется наш фильтр. Их обёртка обычно зовёт сохранённый
   * «оригинал» — то есть снова нас: такой повторный вход уходит прямо в настоящий window.open (без зацикливания). */
  function installOpenGuard() {
    const code = '(() => { const d = document.documentElement; if (!window.open || window.open.__tbrub) return;' +
      'const RE = ' + MARKET_URL_RE + ', KEEP = ' + KEEP_NEW_TAB_RE + ';' +
      'const native = window.open; let inner = native, depth = 0;' +
      'const f = function (url, target) {' +
      '  if (depth) return native.apply(this, arguments);' +
      '  depth++;' +
      '  try {' +
      '    try { if (d.getAttribute("data-tbrub-sametab") === "1" && url && (!target || target === "_blank")) {' +
      '      const u = new URL(String(url), location.href).href;' +
      '      if (RE.test(u) && !KEEP.test(u)) { location.assign(u); return window; } } } catch (e) {}' +
      '    return inner.apply(this, arguments);' +
      '  } finally { depth--; } };' +
      'f.__tbrub = true;' +
      'try { Object.defineProperty(window, "open", { configurable: true, enumerable: true,' +
      '  get() { return f; }, set(v) { if (typeof v === "function" && v !== f) inner = v; } }); }' +
      'catch (e) { window.open = f; }' +
      'd.setAttribute("data-tbrub-open", "1"); })();';
    whenRoot(() => {
      document.documentElement.setAttribute('data-tbrub-sametab', state.sameTab ? '1' : '0');
      try {
        const s = document.createElement('script');
        s.textContent = code;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      } catch (_) { /* CSP запретила — останется перехват ссылок */ }
    });
  }

  function installSameTab() {
    document.addEventListener('click', (e) => {
      if (!state.sameTab || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || a.target !== '_blank' || a.closest('#tbrub-root,#tbrub-imgbtn')) return;
      const href = a.href;
      if (!sameTabUrl(href)) return;
      e.preventDefault();
      location.assign(href);
    }, false);
  }

  function boot() {
    installSameTab();
    Ui.mount();
    ImgTr.install();
    GNotice.firstRun();                               // один раз: перевод идёт через Google — лучше войти в аккаунт
    // диагностика «долго уходит поиск»: сколько прошло от Enter до этой страницы (в консоль)
    try {
      const ls = store.get('lastSearchT', null);
      if (ls && ls.at && Date.now() - ls.at < 60000 && /\/search/.test(location.pathname)) {
        const nav = performance.timeOrigin - ls.at;
        const fcp = (performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint') || {}).startTime;
        console.info('[tb-rub] поиск: перевод ' + ls.tr + ' мс' + (ls.cached ? ' (кэш)' : '') + ' · Enter → начало загрузки ' + Math.round(nav) +
          ' мс · ответ сервера ' + Math.round((performance.getEntriesByType('navigation')[0] || {}).responseStart || 0) + ' мс' + (fcp ? ' · первая отрисовка ' + Math.round(fcp) + ' мс' : ''));
        store.set('lastSearchT', null);
      }
    } catch (_) { /* диагностика не обязательна */ }
    OcrStore.migrate().then(() => OcrStore.schedulePrune(20000));   // кэш фото: переезд в IndexedDB, уборка в простое
    setTimeout(() => ImgAuto.start(), 1500);
    if (MOBILE) { setTimeout(() => MobImg.start(), 1200); MobAsk.start(); }   // телефон: значок «文» на фото, выбор режима
    // движок распознавания поднимаем сразу (модели из кэша браузера — ~1 с), чтобы автоперевод фото стартовал без ожидания
    if (state.imgTr && state.imgAuto) setTimeout(() => OcrEngines.warmup(), 1200);
    Prices.fullScan();
    Watch.start();
    syncRates(false);
    setInterval(() => { if (!document.hidden) syncRates(false); }, 60 * 1000);
    // Перевод страницы стартует после загрузки (после гидратации React), но не позже чем через 2.5 с
    if (state.pageTr) {
      let started = false;
      const go = () => { if (!started && state.pageTr) { started = true; Translator.start(); Ui.render(); } };
      if (document.readyState === 'complete') setTimeout(go, 300);
      else { window.addEventListener('load', () => setTimeout(go, 300), { once: true }); setTimeout(go, 2500); }
    }
  }
 
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
 
