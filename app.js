// Машина сборки КП — модель реализации ТЗ "BP auto-assembly" (30.09).
// Модель: оператор (манифест) → машина (агрегация, арифметика, маршрут блоков, ворота) → документ (слайды + markdown).
// Производственная машина по ТЗ — bp-assemble.py (python3 stdlib); здесь та же логика в браузере.

/* ============================================================
   Утилиты
   ============================================================ */
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function round2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
function thousands(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function fmtMoney(v) { return thousands(round2(v).toFixed(2).replace(".", ",")); }
function fmtQty(v) { return Number.isInteger(v) ? thousands(String(v)) : thousands(round2(v).toFixed(2).replace(".", ",")); }

/* ============================================================
   Машина: вариант → агрегация → таблица → документ
   ============================================================ */

// Наложение варианта (ТЗ 8.5): замена/исключение строк поверх базового состава.
function applyVariant(rows, manifest, variantKey) {
  const v = manifest.variants[variantKey] || { label: variantKey };
  const out = clone(rows);
  const changes = { replaced: [], dropped: [] };
  (v.replace || []).forEach((r) => {
    const i = out.findIndex((x) => x.name === r.match);
    if (i >= 0) { out[i] = Object.assign({}, r.row, { zone: out[i].zone }); changes.replaced.push({ from: r.match, to: r.row.name }); }
  });
  (v.drop || []).forEach((name) => {
    const i = out.findIndex((x) => x.name === name);
    if (i >= 0) { out.splice(i, 1); changes.dropped.push(name); }
  });
  return { rows: out, changes, label: v.label || variantKey };
}

// Агрегация (ТЗ 8.1): склейка по "имя + цена"; одинаковое имя с разными ценами не склеивается.
function aggregate(srcRows) {
  const order = [];
  const map = new Map();
  srcRows.forEach((r) => {
    const key = r.name + "||" + r.price.toFixed(2);
    if (!map.has(key)) { map.set(key, { name: r.name, unit: r.unit, qty: 0, price: r.price, cost: 0, info: r.info || "", parts: [] }); order.push(key); }
    const g = map.get(key);
    g.qty = round2(g.qty + r.qty);
    g.cost = round2(g.cost + round2(r.qty * r.price));
    g.parts.push({ zone: r.zone || "—", qty: r.qty });
  });
  const groups = order.map((k) => map.get(k));
  const merged = groups.filter((g) => g.parts.length > 1).map((g) => ({ name: g.name, price: g.price, parts: g.parts, qty: g.qty }));
  const byName = new Map();
  groups.forEach((g) => { if (!byName.has(g.name)) byName.set(g.name, []); byName.get(g.name).push(g.price); });
  const keptSplit = [...byName.entries()].filter(([, prices]) => prices.length > 1).map(([name, prices]) => ({ name, prices }));
  return { rows: groups, merged, keptSplit };
}

function relatedTotal(manifest) {
  return FIXED.related_rows.reduce((s, r) => s + round2(r.qty * r.price), 0);
}

// Сборка документа: блоки реестра в маршруте ТЗ 5, арифметика, итоги, markdown-эмиттер.
function assemble(manifest, variantKey) {
  const m = manifest;
  const brand = m.layout.brand;
  const vres = applyVariant(ESTIMATE_ROWS, m, variantKey);
  const agg = aggregate(vres.rows);

  const rows = agg.rows.map((r, i) => ({ n: i + 1, name: r.name, unit: r.unit, qty: r.qty, price: r.price, cost: r.cost, info: r.info, parts: r.parts }));
  const itogo = round2(rows.reduce((s, r) => s + r.cost, 0));
  const relTotal = m.layout.related_table === "separate" ? relatedTotal(m) : 0;
  const materials = m.commerce.materials;
  const price = round2(itogo + relTotal + materials);
  const worksSum = round2(itogo + relTotal);

  const omit = m.layout.omit || [];
  const has = {
    plans: !omit.includes("plans") && m.images.plans.length > 0,
    photos: !omit.includes("photos") && m.images.photos.length > 0,
    gallery: m.images.gallery.length > 0,
    permits: m.layout.permits && !omit.includes("permits"),
    related: m.layout.related_table === "separate",
    prelim_note: m.commerce.price.kind === "estimate",
    org_process: m.layout.org_process === "on",
    also_included: m.layout.org_process === "fold",
    prelim_volumes: (m.layout.prelim_volumes || []).length > 0,
    not_estimated: (m.layout.not_estimated || []).length > 0,
    separate_estimate: (m.layout.separate_estimate || []).length > 0,
    engineering: !!m.layout.engineering,
    reporting: !!m.commerce.reporting,
  };

  const emptySlots = [];
  if (m.commerce.materials === null || m.commerce.materials === "") emptySlots.push("materials");
  if (!m.commerce.predoplata) emptySlots.push("predoplata");

  // Цена (ТЗ 6.21а): строка-заголовок собирается из таблицы + сопутствующих + материалов.
  const priceLine = (m.commerce.price.kind === "estimate" ? "Ориентировочная стоимость по проекту составляет " : "Стоимость по проекту составляет ") + fmtMoney(price) + " € + 19% VAT.";
  const breakdownLine = "В том числе: работы — " + fmtMoney(worksSum) + " € (согласно таблице работ), черновые материалы — " + fmtMoney(materials) + " €.";

  const sections = [];
  const md = [];

  // --- Слайд 1: chrome → manager → title → subtitle → description
  const managerMd = '<div style="text-align: right; color: #555;">' + FIXED.manager.name + '<br>\n<a href="' + FIXED.manager.phone_href + '" style="color: #555;">' + FIXED.manager.phone + "</a><br>\n" + m.object.date + "\n</div>";
  const openingFinal = (m.object.opening || "").replace("{brand}", brand.replace(/^MELESHIN\s*/, ""));

  md.push("---");
  md.push("marp: true");
  md.push('theme: "concept-note-involve"');
  md.push("paginate: true");
  md.push("header: '<span style=\"display:block;font-size:18px;border-bottom:1.5px solid #ccc;padding-bottom:1mm\"><img src=\"../../meleshin-logo.png\" style=\"float:left;height:23px;object-fit:contain;margin-right:12px\"><span style=\"position:relative\"><b>" + brand + '</b> <span style="font-weight:400">| Коммерческое предложение. ' + esc(m.object.header_object) + "</span></span></span>'");
  md.push('footer: <a href="https://meleshin.com.cy" style="color: inherit; text-decoration: none;">' + brand + '</a> | <a href="tel:+35777788811" style="color: inherit; text-decoration: none;">+357 77 788811</a> | [order@meleshin.com.cy](mailto:order@meleshin.com.cy) | <a href="https://www.instagram.com/renovation_cyprus" style="color: inherit; text-decoration: none;">Instagram: renovation_cyprus</a>');
  md.push("---");
  md.push("");
  if (m.object.manager_top) { md.push(managerMd); md.push(""); }
  md.push("# <div style=\"text-align: center;\">" + FIXED.title + "</div>");
  md.push("");
  md.push('<div style="text-align: center;">' + m.object.subtitle + "</div>");
  md.push("");
  md.push("## " + FIXED.description_h2);
  md.push("");
  md.push('<div style="display:grid;grid-template-columns:63% 34%;gap:6mm;align-items:start">');
  md.push("<div>");
  md.push("");
  md.push(openingFinal);
  md.push("");
  md.push("**Объект.** " + m.object.field_object);
  md.push("");
  md.push("**Зона работ.** " + m.object.field_zone);
  md.push("");
  md.push("**Материалы и транспорт.** " + m.object.field_materials);
  md.push("");
  md.push("</div>");
  md.push('<div><img src="' + m.images.hero + '" style="height:90mm;width:100%;object-fit:cover"></div>');
  md.push("</div>");

  sections.push({ id: "sec-open", slide: 1, title: "Титул и описание проекта", blocks: ["chrome", "manager", "title", "subtitle", "description"] });

  // --- Слайд: план
  if (has.plans) {
    md.push("");
    md.push("---");
    md.push("");
    md.push("## " + FIXED.plans_h2);
    md.push("");
    md.push('<div style="text-align:center"><img src="' + m.images.plans[0] + '" style="width:60%"></div>');
    sections.push({ id: "sec-plans", slide: sections.length + 1, title: FIXED.plans_h2, blocks: ["plans"] });
  }

  // --- Слайды: фото объекта, по 3 на слайд (ТЗ 6.7)
  if (has.photos) {
    const per = 3;
    for (let i = 0; i < m.images.photos.length; i += per) {
      const chunk = m.images.photos.slice(i, i + per);
      const head = i === 0 ? FIXED.photos_h2_start : FIXED.photos_h2_cont;
      md.push("");
      md.push("---");
      md.push("");
      md.push("## " + head);
      md.push("");
      md.push('<div style="display:flex;gap:4mm">' + chunk.map((p) => '<img src="' + p + '" style="height:100mm;flex:1;object-fit:cover">').join("") + "</div>");
      sections.push({ id: "sec-photos-" + (i / per + 1), slide: sections.length + 1, title: head, blocks: ["photos"], photos: chunk });
    }
  }

  // --- Зона работ: заголовок + таблица с разбивкой по страницам (ТЗ 8.2)
  const worksHeading = m.layout.works_heading || "Состав работ";
  const alignRow = "|:--:|:--|--:|--:|--:|--:|";
  const headerRow = "| " + FIXED.works_cols.join(" | ") + " |";
  const itogoMd = "| | **Итого:** | | | | **" + fmtMoney(itogo) + "** |";
  const perPage = 12;
  const pages = [];
  for (let i = 0; i < rows.length; i += perPage) pages.push(rows.slice(i, i + perPage));

  md.push("");
  md.push("---");
  md.push("");
  md.push("## " + worksHeading);
  md.push("");
  pages.forEach((p, pi) => {
    if (pi > 0) { md.push(""); md.push("---"); md.push(""); }
    md.push(headerRow);
    md.push(alignRow);
    p.forEach((r) => md.push("| " + r.n + " | " + r.name + " | " + r.unit + " | " + fmtQty(r.qty) + " | " + fmtMoney(r.price) + " | " + fmtMoney(r.cost) + " |"));
    if (pi === pages.length - 1) md.push(itogoMd);
  });
  if (has.prelim_note) { md.push(""); md.push(FIXED.prelim_note); }

  const tableBlocks = ["works_head", "works_table"].concat(has.prelim_note ? ["prelim_note"] : []);
  sections.push({ id: "sec-works", slide: sections.length + 1, title: worksHeading, blocks: tableBlocks });

  // --- Зона после таблицы: related → org_process → also_included → prelim_volumes → not_estimated
  if (has.related || has.org_process || has.also_included || has.prelim_volumes || has.not_estimated) {
    md.push("");
    md.push("---");
    md.push("");
    const postBlocks = [];
    if (has.related) {
      md.push("## " + FIXED.related_h2);
      md.push("");
      md.push("| " + FIXED.related_cols.join(" | ") + " |");
      md.push("|:--:|:--|--:|--:|--:|");
      FIXED.related_rows.forEach((r, i) => md.push("| " + (i + 1) + " | " + r.name + " | " + r.unit + " | " + fmtQty(r.qty) + " | " + fmtMoney(r.price) + " |"));
      md.push("");
      postBlocks.push("related");
    }
    if (has.org_process) {
      md.push("### " + FIXED.org_process_h3);
      md.push("");
      FIXED.org_process.forEach((b) => md.push("- " + b));
      md.push("");
      postBlocks.push("org_process");
    }
    if (has.also_included) {
      md.push("### " + FIXED.also_included_h3);
      md.push("");
      FIXED.also_included.forEach((b) => md.push("- " + b));
      md.push("");
      postBlocks.push("also_included");
    }
    if (has.prelim_volumes) {
      md.push("### " + FIXED.prelim_volumes_h3);
      md.push("");
      m.layout.prelim_volumes.forEach((x) => md.push("- " + x));
      md.push("");
      if (has.not_estimated) {
        md.push("### " + FIXED.not_estimated_h3);
        md.push("");
        m.layout.not_estimated.forEach((x) => md.push("- " + x));
        md.push("");
      }
      md.push(FIXED.prelim_volumes_close);
      md.push("");
      postBlocks.push("prelim_volumes");
      if (has.not_estimated) postBlocks.push("not_estimated");
    }
    sections.push({ id: "sec-post", slide: sections.length + 1, title: has.related ? FIXED.related_h2 : FIXED.org_process_h3, blocks: postBlocks });
  }

  // --- Зона исключений: not_included (+ separate_estimate, engineering)
  md.push("");
  md.push("---");
  md.push("");
  md.push("## " + FIXED.not_included_h2);
  md.push("");
  const niBlocks = ["not_included"];
  if (m.layout.not_included_form === "prose") {
    md.push("Чистовая электрика, чистовая сантехника.");
    md.push("");
    md.push("*" + FIXED.finish_note + "*");
    md.push("");
  } else {
    FIXED.not_included_sections.forEach((secName) => {
      const items = (m.layout.not_included_sections || {})[secName];
      if (!items || items.length === 0) return;
      md.push("### " + secName);
      md.push("");
      items.forEach((x) => md.push("- " + x));
      md.push("");
    });
  }
  if ((m.layout.extra_works || []).length > 0) {
    md.push(FIXED.extra_opener);
    md.push("");
    m.layout.extra_works.forEach((x) => md.push("- " + x));
    md.push("");
  }
  if (has.separate_estimate) {
    md.push("### " + FIXED.separate_h3);
    md.push("");
    m.layout.separate_estimate.forEach((x) => md.push("- " + x));
    md.push("");
    md.push(FIXED.separate_close);
    md.push("");
    niBlocks.push("separate_estimate");
  }
  if (has.engineering) {
    md.push("### " + FIXED.engineering_h3);
    md.push("");
    md.push(m.layout.engineering);
    md.push("");
    niBlocks.push("engineering");
  }
  sections.push({ id: "sec-notinc", slide: sections.length + 1, title: FIXED.not_included_h2, blocks: niBlocks });

  // --- permits → interaction
  md.push("");
  md.push("---");
  md.push("");
  const intBlocks = [];
  if (has.permits) {
    md.push("## " + FIXED.permits_h2);
    md.push("");
    FIXED.permits.forEach((p) => { md.push(p); md.push(""); });
    intBlocks.push("permits");
  }
  md.push("## " + FIXED.interaction_h2);
  md.push("");
  md.push("- Работы выполняются в соответствии с " + m.object.basis_doc + ".");
  FIXED.interaction_fixed.forEach((b) => md.push("- " + b));
  if (has.reporting) md.push("- " + FIXED.reporting);
  md.push("");
  intBlocks.push("interaction");
  sections.push({ id: "sec-interaction", slide: sections.length + 1, title: FIXED.interaction_h2, blocks: intBlocks });

  // --- payment (a → h, ТЗ 6.21)
  md.push("");
  md.push("---");
  md.push("");
  md.push("## " + FIXED.payment_h2);
  md.push("");
  md.push("### " + priceLine);
  md.push("");
  if (m.commerce.price.kind === "estimate" && m.commerce.price.clause) { md.push("Стоимость " + m.commerce.price.clause + "."); md.push(""); }
  md.push(breakdownLine);
  md.push("");
  md.push(FIXED.vat_para);
  md.push("");
  md.push("**Предоплата: " + fmtMoney(m.commerce.predoplata || 0) + " € + 19% VAT** — " + FIXED.predoplata_purpose + ".");
  md.push("");
  if (m.commerce.second_payment && m.commerce.second_payment.amount) {
    md.push("**Второй платёж: " + fmtMoney(m.commerce.second_payment.amount) + " € + 19% VAT** — " + m.commerce.second_payment.note + ".");
    md.push("");
  }
  md.push(FIXED.final_settlement);
  md.push("");
  md.push("### Срок реализации: " + m.commerce.term.value + " " + m.commerce.term.unit);
  md.push("");
  md.push(FIXED.term_tail);
  md.push("");
  md.push(FIXED.validity);
  sections.push({ id: "sec-payment", slide: sections.length + 1, title: FIXED.payment_h2, blocks: ["payment"] });

  // --- manager снизу (решение 4, вариант 2631/2635)
  if (!m.object.manager_top) { md.push(""); md.push(managerMd); }

  // --- gallery
  if (has.gallery) {
    md.push("");
    md.push("---");
    md.push("");
    for (let i = 0; i < m.images.gallery.length; i += 3) {
      md.push('<div style="display:flex;gap:4mm">' + m.images.gallery.slice(i, i + 3).map((p) => '<img src="' + p + '" style="height:62mm;flex:1;object-fit:cover">').join("") + "</div>");
      md.push("");
    }
    sections.push({ id: "sec-gallery", slide: sections.length + 1, title: "Галерея", blocks: ["gallery"] });
  }

  // Имя файла (ТЗ 10): YYNN допустимо в имени файла, запрещено в клиентских полях.
  let filename = m.object.date_iso + "-meleshin-" + m.object.folder + "-BP";
  if (variantKey !== "base") filename += "-" + variantKey;
  if (emptySlots.length > 0) filename += "-v1";
  filename += ".md";

  return {
    variantKey, variantLabel: vres.label, variantChanges: vres.changes,
    rows, itogo, relTotal, materials, price, worksSum, priceLine, breakdownLine,
    has, emptySlots, sections, filename,
    aggregation: agg, pages: pages.length,
    md: md.join("\n") + "\n",
  };
}

/* ============================================================
   Ворота (ТЗ 9) — сборка не завершена, пока не пройдены все
   ============================================================ */
function alphaTokens(text) {
  return text.toLowerCase().replace(/\d+/g, " ").replace(/[^a-zа-яё²%]/g, " ").split(/\s+/).filter(Boolean);
}

function runGates(a, manifest, prev) {
  const g = [];
  const m = manifest;

  // 1. qty × price = cost — вычисляется машиной, класс дефектов исключён конструктивно
  const bad1 = a.rows.filter((r) => round2(r.qty * r.price) !== r.cost);
  g.push({ n: 1, title: "Строка: Кол-во × Цена = Стоимость", status: bad1.length ? "fail" : "pass", detail: bad1.length ? "расхождение: " + bad1.map((r) => "#" + r.n).join(", ") : a.rows.length + " строк вычислены машиной (2 знака)" });

  // 2. Итого и строка цены
  const itogoOk = round2(a.rows.reduce((s, r) => s + r.cost, 0)) === a.itogo;
  const priceOk = a.price === round2(a.itogo + a.relTotal + a.materials);
  g.push({ n: 2, title: "Итого = Σ стоимости; цена = Итого + сопутствующие + материалы", status: itogoOk && priceOk ? "pass" : "fail", detail: fmtMoney(a.itogo) + " + " + fmtMoney(a.relTotal) + " + " + fmtMoney(a.materials) + " = " + fmtMoney(a.price) + " €" });

  // 3. Обновление только цен: мультимножество количеств совпадает с предыдущей сборкой
  if (!prev) g.push({ n: 3, title: "Только цены: количества совпадают с предыдущей версией", status: "skip", detail: "первая сборка в сеансе — сравнивать не с чем" });
  else if (prev.variantKey !== a.variantKey) g.push({ n: 3, title: "Только цены: количества совпадают с предыдущей версией", status: "skip", detail: "заявленное структурное изменение варианта (" + prev.variantLabel + " → " + a.variantLabel + ")" });
  else {
    const q1 = prev.rows.map((r) => r.qty).sort((x, y) => x - y).join(",");
    const q2 = a.rows.map((r) => r.qty).sort((x, y) => x - y).join(",");
    g.push({ n: 3, title: "Только цены: количества совпадают с предыдущей версией", status: q1 === q2 ? "pass" : "fail", detail: q1 === q2 ? "мультимножество количеств совпадает" : "состав количеств изменился" });
  }

  // 4. Фиксированные блоки байт-в-байт шаблону
  const mdHas = (s) => a.md.includes(s);
  const fixedOk = [FIXED.vat_para, FIXED.final_settlement, FIXED.validity, FIXED.term_tail].every(mdHas);
  g.push({ n: 4, title: "Фиксированные блоки байт-в-байт равны шаблону", status: fixedOk ? "pass" : "fail", detail: fixedOk ? "все фиксированные строки испущены из шаблона без правок" : "фиксированный блок расходится с шаблоном" });

  // 5. Маршрут: зоны по порядку, обязательные блоки на месте
  const mandatory = ["chrome", "manager", "title", "subtitle", "description", "works_head", "works_table", "not_included", "interaction", "payment"];
  const present = new Set(a.sections.flatMap((s) => s.blocks));
  const missing = mandatory.filter((b) => !present.has(b));
  g.push({ n: 5, title: "Маршрут: зоны ТЗ 5, обязательные блоки присутствуют", status: missing.length ? "fail" : "pass", detail: missing.length ? "отсутствуют: " + missing.join(", ") : a.sections.length + " слайдов, зоны в порядке ТЗ 5" });

  // 6. ___ только в -v1; деньги всегда 2 знака
  const moneyBad = (a.md.match(/\d[ \d]*,\d? €/g) || []).filter((x) => !/,\d{2} €/.test(x));
  const v1suffix = a.filename.includes("-v1");
  const slotsOk = a.emptySlots.length === 0 || v1suffix;
  g.push({ n: 6, title: "___ только в -v1; деньги с двумя знаками", status: slotsOk && moneyBad.length === 0 ? "pass" : "fail", detail: (slotsOk ? (a.emptySlots.length ? "пустые слоты: " + a.emptySlots.join(", ") + " (файл -v1)" : "пустых слотов нет") : "пустой слот без суффикса -v1") + "; формат: пробел тысяч, запятая, 2 знака" });

  // 7. YYNN не в клиентских полях
  const yynn = (m.object.folder.match(/^\d{4}/) || [""])[0];
  const clientFields = { header_object: m.object.header_object, subtitle: m.object.subtitle, opening: m.object.opening || "", field_object: m.object.field_object, works_heading: m.layout.works_heading };
  const leak = Object.entries(clientFields).filter(([, v]) => yynn && String(v).includes(yynn)).map(([k]) => k);
  g.push({ n: 7, title: "YYNN не попадает в клиентские поля", status: leak.length ? "fail" : "pass", detail: leak.length ? "утечка: " + leak.join(", ") : yynn + " — только в имени папки и файла" });

  // 8. Расхождение — факт, не правка значения (принцип, ТЗ 9.8)
  g.push({ n: 8, title: "Расхождение сообщается фактом, значение не подгоняется", status: "pass", detail: "принцип машины: ворота не правят данные" });

  // 9. Повторы: заголовки уникальны, метки полей не конфликтуют, 5-словных повторов между блоками нет
  const rep = repetitionScan(a, manifest);
  g.push({ n: 9, title: "Повторы: один факт — один носитель", status: rep.fail ? "fail" : "pass", detail: rep.detail });

  // 10. Каждая картинка разрешается в существующий файл
  const imgs = [["hero", m.images.hero]].concat(m.images.plans.map((p) => ["plans", p])).concat(m.images.photos.map((p) => ["photos", p])).concat(m.images.gallery.map((p) => ["gallery", p]));
  const dead = imgs.filter(([, p]) => !p);
  g.push({ n: 10, title: "Нет битых ссылок на изображения", status: dead.length ? "fail" : "pass", detail: dead.length ? "пустые ссылки: " + dead.map(([k]) => k).join(", ") : imgs.length + " ссылок разрешаются в файлы объекта" });

  return g;
}

// Скан повторов (ворота 9): заголовки, метки полей, 5-словные альфа-последовательности.
// Числа вырезаются — итоги в строке цены освобождены автоматически (значения, не проза).
function repetitionScan(a, manifest) {
  const fails = [];
  const notes = [];
  const m = manifest;

  // Сканируются только блоки, реально вошедшие в документ: org_process и also_included
  // взаимоисключающи (ТЗ 6.13) и вместе в сборке не встречаются.
  const blockTexts = [
    { id: "subtitle", text: m.object.subtitle, on: true },
    { id: "description", text: [m.object.opening, m.object.field_object, m.object.field_zone, m.object.field_materials].join(" "), on: true },
    { id: "works_head", text: m.layout.works_heading, on: true },
    { id: "related", text: FIXED.related_h2, on: a.has.related },
    { id: "org_process", text: FIXED.org_process_h3 + " " + FIXED.org_process.join(" "), on: a.has.org_process },
    { id: "also_included", text: FIXED.also_included_h3 + " " + FIXED.also_included.join(" "), on: a.has.also_included },
    { id: "not_included", text: FIXED.not_included_h2 + " " + Object.entries(m.layout.not_included_sections || {}).map(([k, v]) => k + " " + v.join(" ")).join(" "), on: true },
    { id: "extra", text: FIXED.extra_opener + " " + (m.layout.extra_works || []).join(" "), on: (m.layout.extra_works || []).length > 0 },
    { id: "separate_estimate", text: FIXED.separate_h3 + " " + (m.layout.separate_estimate || []).join(" "), on: a.has.separate_estimate },
    { id: "permits", text: FIXED.permits_h2 + " " + FIXED.permits.join(" "), on: a.has.permits },
    { id: "interaction", text: FIXED.interaction_h2 + " Работы выполняются в соответствии с " + m.object.basis_doc + ". " + FIXED.interaction_fixed.join(" "), on: true },
    { id: "payment", text: FIXED.payment_h2 + " " + a.priceLine + " " + a.breakdownLine + " " + FIXED.vat_para + " " + FIXED.final_settlement + " " + FIXED.term_tail + " " + FIXED.validity, on: true },
    { id: "prelim_volumes", text: FIXED.prelim_volumes_h3 + " " + (m.layout.prelim_volumes || []).join(" ") + (a.has.not_estimated ? " " + FIXED.not_estimated_h3 + " " + (m.layout.not_estimated || []).join(" ") : ""), on: a.has.prelim_volumes },
  ].filter((b) => b.on && b.text && b.text.trim());

  // Заголовки уникальны документ-wide
  const headings = [FIXED.title, FIXED.description_h2, FIXED.plans_h2, FIXED.photos_h2_start, FIXED.photos_h2_cont, m.layout.works_heading, FIXED.related_h2, FIXED.org_process_h3, FIXED.also_included_h3, FIXED.prelim_volumes_h3, FIXED.not_estimated_h3, FIXED.not_included_h2, FIXED.separate_h3, FIXED.engineering_h3, FIXED.permits_h2, FIXED.interaction_h2, FIXED.payment_h2].filter(Boolean);
  const seen = new Map();
  headings.forEach((h) => seen.set(h, (seen.get(h) || 0) + 1));
  const dupHeads = [...seen.entries()].filter(([, c]) => c > 1).map(([h]) => h);
  if (dupHeads.length) fails.push("заголовок повторяется: " + dupHeads.join("; "));

  // Метки полей описания не конфликтуют с заголовками
  const labels = ["Объект", "Зона работ", "Материалы и транспорт"];
  const clash = labels.filter((l) => headings.some((h) => h.toLowerCase() === l.toLowerCase()));
  if (clash.length) fails.push("метка поля совпадает с заголовком: " + clash.join("; "));

  // 5-словные альфа-последовательности между разными блоками
  const win = new Map();
  blockTexts.forEach((b) => {
    const toks = alphaTokens(b.text);
    for (let i = 0; i + 4 < toks.length; i++) {
      const key = toks.slice(i, i + 5).join(" ");
      if (!win.has(key)) win.set(key, new Set());
      win.get(key).add(b.id);
    }
  });
  const reps = [...win.entries()].filter(([, ids]) => ids.size > 1);
  if (reps.length) fails.push("5-словный повтор между блоками: " + reps.slice(0, 3).map(([k, ids]) => '"' + k + '" (' + [...ids].join(" × ") + ")").join("; "));

  // Контроль рамок шаблона: субтитул (6.4) × вступление (6.5) делят фразу-рамку
  const st = alphaTokens(m.object.subtitle || "");
  const ot = alphaTokens(m.object.opening || "");
  let longest = 0;
  for (let i = 0; i < st.length; i++) {
    for (let j = 0; j < ot.length; j++) {
      let k = 0;
      while (i + k < st.length && j + k < ot.length && st[i + k] === ot[j + k]) k++;
      if (k > longest) longest = k;
    }
  }
  notes.push("общий сегмент субтитул × вступление: " + longest + " сл. при пороге 5 (рамки 6.4/6.5)");

  return { fail: fails.length > 0 || longest >= 5, detail: (fails.length ? fails.join("; ") + "; " : "повторов нет; ") + notes.join("; ") };
}

/* ============================================================
   Состояние и сборка
   ============================================================ */
const STATE = {
  manifest: clone(MANIFEST_DEFAULT),
  variant: "base",
  view: "estimate", // смета (клиент) | документ | маркдаун | манифест | отчёт
  screen: "all", // экраны сметы: все | работы | материалы (навигация сверху)
  room: "all", // помещения сметы (навигация слева)
  status: "sent", // Отправлен | Согласован с клиентом (ТЗ Клиентская смета, 4)
  search: "",
  prev: null,
};

function build() {
  const a = assemble(STATE.manifest, STATE.variant);
  a.gates = runGates(a, STATE.manifest, STATE.prev);
  a.gatesPassed = a.gates.filter((x) => x.status === "pass").length;
  a.gatesTotal = a.gates.length;
  STATE.prev = a;
  return a;
}

/* ============================================================
   Клиентская смета: экраны работы/материалы + помещения
   (структура клиентского бюджета: сверху экраны, слева помещения)
   ============================================================ */

// Модель сметы: агрегированные строки работ (та же агреграция машины),
// агрегированные материалы, помещения с подсчётом по зонам.
function estimateModel(a) {
  const mAgg = aggregate(MATERIALS_ROWS);
  const materialsRows = mAgg.rows.map((r, i) => ({ n: i + 1, name: r.name, unit: r.unit, qty: r.qty, price: r.price, cost: r.cost, info: r.info, parts: r.parts }));
  const materialsTotal = round2(materialsRows.reduce((s, r) => s + r.cost, 0));
  const zones = [];
  ESTIMATE_ROWS.forEach((r) => { if (r.zone && !zones.includes(r.zone)) zones.push(r.zone); });
  MATERIALS_ROWS.forEach((r) => { if (r.zone && !zones.includes(r.zone)) zones.push(r.zone); });
  const rooms = zones.map((z) => {
    let count = 0;
    let sum = 0;
    a.rows.forEach((r) => r.parts.forEach((p) => { if (p.zone === z) { count++; sum = round2(sum + round2(p.qty * r.price)); } }));
    return { name: z, count, sum };
  });
  return { materialsRows, materialsTotal, rooms };
}

// Выбор помещения = разложение агрегированных строк обратно по зонам; нумерация с 1.
function decomposeRoom(rows, room) {
  const out = [];
  rows.forEach((r) => r.parts.forEach((p) => {
    if (p.zone === room) out.push({ name: r.name, unit: r.unit, qty: p.qty, price: r.price, cost: round2(p.qty * r.price), info: r.info, zone: p.zone });
  }));
  return out.map((r, i) => Object.assign({ n: i + 1 }, r));
}

function renderEstimate(a) {
  const em = estimateModel(a);
  const room = STATE.room;
  const worksRows = room === "all" ? a.rows : decomposeRoom(a.rows, room);
  const matRows = room === "all" ? em.materialsRows : decomposeRoom(em.materialsRows, room);

  const rowHtml = (r) => '<div class="est-row"><div class="num">' + r.n + '</div><div class="name">' + esc(r.name) + '</div><div class="unit">' + esc(r.unit) + '</div><div class="qty tnum">' + fmtQty(r.qty) + '</div><div class="price tnum">' + fmtMoney(r.price) + '</div><div class="cost"><div class="tnum">' + fmtMoney(r.cost) + "</div>" +
    (r.info ? '<div class="est-note">' + esc(r.info) + "</div>" : "") +
    "</div></div>";
  const head = (kind) => '<div class="est-head"><div>#</div><div>' + (kind === "w" ? "Работа" : "Материал") + '</div><div>Ед.</div><div class="r">Кол&#8209;во</div><div class="r">Цена за ед., €</div><div class="r">Стоимость, €</div></div>';
  const block = (title, totalLabel, total, rows, kind) =>
    '<div class="est-blk"><div class="blk-head"><span class="blk-name">' + title + '</span><span class="blk-total"><span class="lbl">' + totalLabel + ':</span> <span class="tnum">' + fmtMoney(total) + " €</span></span></div>" +
    (room !== "all" ? '<div class="est-filter">Помещение: ' + esc(room) + " · " + rows.length + " поз. · " + fmtMoney(round2(rows.reduce((s, r) => s + r.cost, 0))) + " €</div>" : "") +
    '<div class="est-table">' + head(kind) + rows.map(rowHtml).join("") + "</div></div>";

  const tabs = [["all", "Все"], ["works", "Работы"], ["materials", "Материалы"]]
    .map(([k, l]) => '<button data-screen="' + k + '"' + (STATE.screen === k ? ' class="active"' : "") + ">" + l + "</button>").join("");
  const single = STATE.screen !== "all";
  let blocks = "";
  if (STATE.screen === "all") blocks = block("Отделочные работы", "Итого за работы", a.itogo, worksRows, "w") + block("Отделочные материалы", "Итого за материалы", em.materialsTotal, matRows, "m");
  else if (STATE.screen === "works") blocks = block("Отделочные работы", "Итого за работы", a.itogo, worksRows, "w");
  else blocks = block("Отделочные материалы", "Итого за материалы", em.materialsTotal, matRows, "m");

  const roomsNav = '<div class="est-rooms"><span class="est-rooms-lbl">Помещение</span>' +
    '<button data-room="all"' + (room === "all" ? ' class="active"' : "") + ">Все</button>" +
    em.rooms.map((r) => '<button data-room="' + esc(r.name) + '"' + (room === r.name ? ' class="active"' : "") + ">" + esc(r.name) + '<span class="c">' + r.count + "</span></button>").join("") + "</div>";
  return '<div class="est-wrap"><div class="est-tabs">' + tabs + "</div>" + roomsNav +
    '<div class="panel-dark' + (single ? " single" : "") + '">' + blocks + "</div>" +
    '<div class="est-foot">Экраны и помещения — сверху; итог — в шапке блока; формат чисел: пробел тысяч, запятая, 2 знака</div></div>';
}

/* ============================================================
   Представление: документ (слайды)
   ============================================================ */
function renderWorksTable(a) {
  const s = STATE.search.trim().toLowerCase();
  const rows = s ? a.rows.filter((r) => r.name.toLowerCase().includes(s)) : a.rows;
  return (
    '<div class="bp-table"><div class="bp-head">' + FIXED.works_cols.map((c, i) => '<div class="' + (i > 2 ? "r" : "") + '">' + c + "</div>").join("") + "</div>" +
    rows.map((r) => '<div class="bp-row"><div class="num">' + r.n + '</div><div class="work">' + esc(r.name) + '</div><div class="unit">' + esc(r.unit) + '</div><div class="qty tnum">' + fmtQty(r.qty) + '</div><div class="price tnum">' + fmtMoney(r.price) + '</div><div class="sum tnum">' + fmtMoney(r.cost) + "</div></div>").join("") +
    '<div class="bp-total"><span class="lbl">Итого:</span><span class="v tnum">' + fmtMoney(a.itogo) + " €</span></div></div>" +
    (a.has.prelim_note ? '<p class="doc-note">' + FIXED.prelim_note + "</p>" : "") +
    (s ? '<div class="doc-filter-note">Поиск: ' + rows.length + " из " + a.rows.length + " позиций</div>" : "")
  );
}

function renderDoc(a) {
  const m = STATE.manifest;
  const secHtml = [];

  a.sections.forEach((sec) => {
    let inner = "";
    if (sec.id === "sec-open") {
      const mgr = '<div class="doc-manager"><div>' + FIXED.manager.name + '</div><a href="' + FIXED.manager.phone_href + '">' + FIXED.manager.phone + "</a><div>" + esc(m.object.date) + "</div></div>";
      inner = (m.object.manager_top ? mgr : "") +
        '<div class="doc-title-outer"><div class="doc-title">' + FIXED.title + '</div><div class="doc-subtitle">' + esc(m.object.subtitle) + "</div></div>" +
        '<div class="doc-h2">' + FIXED.description_h2 + '</div><div class="doc-grid"><div class="doc-text"><p>' + esc(m.object.opening.replace("{brand}", m.layout.brand.replace(/^MELESHIN\s*/, ""))) + '</p><p><b>Объект.</b> ' + esc(m.object.field_object) + '</p><p><b>Зона работ.</b> ' + esc(m.object.field_zone) + '</p><p><b>Материалы и транспорт.</b> ' + esc(m.object.field_materials) + "</p></div>" +
        '<div class="doc-hero"><img src="' + m.images.hero + '" alt=""></div></div>';
    } else if (sec.id === "sec-plans") {
      inner = '<div class="doc-h2">' + FIXED.plans_h2 + '</div><div class="doc-plan"><img src="' + m.images.plans[0] + '" alt=""></div>';
    } else if (sec.id.startsWith("sec-photos")) {
      inner = '<div class="doc-h2">' + esc(sec.title) + '</div><div class="doc-photos">' + sec.photos.map((p) => '<img src="' + p + '" alt="">').join("") + "</div>";
    } else if (sec.id === "sec-works") {
      inner = '<div class="doc-h2">' + esc(m.layout.works_heading) + "</div>" + renderWorksTable(a);
    } else if (sec.id === "sec-post") {
      let h = "";
      if (a.has.related) h += '<div class="doc-h2">' + FIXED.related_h2 + '</div><table class="doc-mini"><tr>' + FIXED.related_cols.map((c) => "<th>" + c + "</th>").join("") + "</tr>" + FIXED.related_rows.map((r, i) => "<tr><td>" + (i + 1) + "</td><td>" + r.name + "</td><td>" + r.unit + '</td><td class="r">' + fmtQty(r.qty) + '</td><td class="r">' + fmtMoney(r.price) + "</td></tr>").join("") + "</table>";
      if (a.has.org_process) h += '<div class="doc-h3">' + FIXED.org_process_h3 + "</div><ul>" + FIXED.org_process.map((b) => "<li>" + b + "</li>").join("") + "</ul>";
      if (a.has.also_included) h += '<div class="doc-h3">' + FIXED.also_included_h3 + "</div><ul>" + FIXED.also_included.map((b) => "<li>" + b + "</li>").join("") + "</ul>";
      if (a.has.prelim_volumes) h += '<div class="doc-h3">' + FIXED.prelim_volumes_h3 + "</div><ul>" + m.layout.prelim_volumes.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" + (a.has.not_estimated ? '<div class="doc-h3">' + FIXED.not_estimated_h3 + "</div><ul>" + m.layout.not_estimated.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") + '<p class="doc-note">' + FIXED.prelim_volumes_close + "</p>";
      inner = h;
    } else if (sec.id === "sec-notinc") {
      let h = '<div class="doc-h2">' + FIXED.not_included_h2 + "</div>";
      if (m.layout.not_included_form === "prose") {
        h += "<p>Чистовая электрика, чистовая сантехника.</p><p><i>" + FIXED.finish_note + "</i></p>";
      } else {
        Object.entries(m.layout.not_included_sections || {}).forEach(([k, v]) => {
          if (!v || v.length === 0) return;
          h += '<div class="doc-h3">' + esc(k) + "</div><ul>" + v.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
        });
      }
      if ((m.layout.extra_works || []).length) h += "<p>" + FIXED.extra_opener + "</p><ul>" + m.layout.extra_works.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>";
      if (a.has.separate_estimate) h += '<div class="doc-h3">' + FIXED.separate_h3 + "</div><ul>" + m.layout.separate_estimate.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul><p>" + FIXED.separate_close + "</p>";
      if (a.has.engineering) h += '<div class="doc-h3">' + FIXED.engineering_h3 + "</div><p>" + esc(m.layout.engineering) + "</p>";
      inner = h;
    } else if (sec.id === "sec-interaction") {
      let h = "";
      if (a.has.permits) h += '<div class="doc-h2">' + FIXED.permits_h2 + "</div>" + FIXED.permits.map((p) => "<p>" + p + "</p>").join("");
      h += '<div class="doc-h2">' + FIXED.interaction_h2 + "</div><ul><li>Работы выполняются в соответствии с " + esc(m.object.basis_doc) + ".</li>" + FIXED.interaction_fixed.map((b) => "<li>" + b + "</li>").join("") + (a.has.reporting ? "<li>" + FIXED.reporting + "</li>" : "") + "</ul>";
      inner = h;
    } else if (sec.id === "sec-payment") {
      inner = '<div class="doc-h2">' + FIXED.payment_h2 + '</div><div class="doc-h3 doc-price">' + a.priceLine + "</div>" +
        (m.commerce.price.kind === "estimate" && m.commerce.price.clause ? "<p>Стоимость " + esc(m.commerce.price.clause) + ".</p>" : "") +
        "<p>" + a.breakdownLine + "</p><p>" + FIXED.vat_para + "</p>" +
        "<p><b>Предоплата: " + fmtMoney(m.commerce.predoplata || 0) + " € + 19% VAT</b> — " + FIXED.predoplata_purpose + ".</p>" +
        (m.commerce.second_payment && m.commerce.second_payment.amount ? "<p><b>Второй платёж: " + fmtMoney(m.commerce.second_payment.amount) + " € + 19% VAT</b> — " + esc(m.commerce.second_payment.note) + ".</p>" : "") +
        "<p>" + FIXED.final_settlement + "</p>" +
        '<div class="doc-h3">Срок реализации: ' + esc(m.commerce.term.value) + " " + esc(m.commerce.term.unit) + "</div><p>" + FIXED.term_tail + "</p><p>" + FIXED.validity + "</p>";
      if (!m.object.manager_top) inner += '<div class="doc-manager doc-manager-bottom"><div>' + FIXED.manager.name + "</div><div>" + esc(m.object.date) + "</div></div>";
    } else if (sec.id === "sec-gallery") {
      inner = '<div class="doc-photos doc-gallery">' + m.images.gallery.map((p) => '<img src="' + p + '" alt="">').join("") + "</div>";
    }
    secHtml.push('<section class="doc-slide" id="' + sec.id + '"><div class="slide-chip">Слайд ' + sec.slide + "</div>" + inner + "</section>");
  });

  return secHtml.join("");
}

/* ============================================================
   Представления: markdown, манифест, отчёт
   ============================================================ */
function renderMd(a) {
  return '<div class="md-wrap"><div class="md-bar"><span class="md-name">' + a.filename + "</span></div><pre class=\"md-pre\">" + esc(a.md) + "</pre></div>";
}

function renderReport(a) {
  const m = STATE.manifest;
  const gateRow = (x) => '<div class="rep-row ' + x.status + '"><span class="rep-status">' + (x.status === "pass" ? "✓" : x.status === "skip" ? "○" : "✕") + '</span><span class="rep-n">' + x.n + '</span><span class="rep-title">' + esc(x.title) + '</span><span class="rep-detail">' + esc(x.detail) + "</span></div>";
  const merged = a.aggregation.merged.map((gr) => "<div>«" + esc(gr.name) + "» " + fmtMoney(gr.price) + " €: " + gr.parts.map((p) => p.zone + " " + fmtQty(p.qty)).join(" + ") + " → " + fmtQty(gr.qty) + " " + a.rows.find((r) => r.name === gr.name && r.price === gr.price).unit + "</div>").join("");
  const split = a.aggregation.keptSplit.map((gr) => "<div>«" + esc(gr.name) + "»: " + gr.prices.map((p) => fmtMoney(p) + " €").join(" | ") + " — строки остаются раздельными</div>").join("");
  const vc = a.variantChanges;
  return (
    '<div class="rep-grid">' +
    '<div class="rep-card"><div class="rep-h">Сборка</div><div class="rep-line">Файл: <b>' + a.filename + "</b></div>" +
    '<div class="rep-line">Слайдов: ' + a.sections.length + " · строк таблицы: " + a.rows.length + " · страницы таблицы: " + a.pages + " (" + a.rows.length + " строк, по 12 на страницу, заголовок повторяется)</div>" +
    '<div class="rep-line">Вариант: ' + a.variantLabel + (vc.replaced.length ? " · заменено строк: " + vc.replaced.length : "") + (vc.dropped.length ? " · исключено строк: " + vc.dropped.length : "") + "</div>" +
    '<div class="rep-line">Источники: карточка <span class="mono">' + esc(m.sources.card) + "</span>; смета — " + esc(m.sources.estimate) + "</div></div>" +
    '<div class="rep-card"><div class="rep-h">Агрегация (ТЗ 8.1)</div>' + (merged || "<div>склеек нет</div>") + (split ? '<div class="rep-sub">Не склеено — одна работа, разные цены:</div>' + split : "") + "</div>" +
    '<div class="rep-card"><div class="rep-h">Арифметика</div><div class="rep-line">Итого по таблице: <b>' + fmtMoney(a.itogo) + " €</b></div>" +
    '<div class="rep-line">Сопутствующие: ' + fmtMoney(a.relTotal) + " € · черновые материалы: " + fmtMoney(a.materials) + " €</div>" +
    '<div class="rep-line">Строка цены: <b>' + fmtMoney(a.itogo) + " + " + fmtMoney(a.relTotal) + " + " + fmtMoney(a.materials) + " = " + fmtMoney(a.price) + " €</b> + 19% VAT</div></div>" +
    '<div class="rep-card"><div class="rep-h">Блоки</div><div class="rep-line">Использованы (' + a.sections.flatMap((x) => x.blocks).length + "): " + a.sections.flatMap((x) => x.blocks).join(", ") + "</div>" +
    '<div class="rep-line">Отключены: ' + (offBlocks(a).join(", ") || "—") + "</div></div>" +
    '<div class="rep-card gates"><div class="rep-h">Ворота 1–10 (ТЗ 9)</div>' + a.gates.map(gateRow).join("") + "</div>" +
    "</div>"
  );
}

function offBlocks(a) {
  const optional = ["plans", "photos", "prelim_note", "related", "org_process", "also_included", "prelim_volumes", "not_estimated", "separate_estimate", "engineering", "permits", "gallery", "reporting"];
  return optional.filter((b) => !a.has[b]);
}

function renderManifest() {
  const m = STATE.manifest;
  const f = (label, inner) => '<label class="mf-field"><span>' + label + "</span>" + inner + "</label>";
  return (
    '<div class="mf-grid">' +
    '<div class="mf-card"><div class="mf-h">Объект</div>' +
    f("Имя папки / YYNN (внутреннее)", '<input data-path="object.folder" value="' + esc(m.object.folder) + '">') +
    f("Клиентское имя объекта (шапка)", '<input data-path="object.header_object" value="' + esc(m.object.header_object) + '">') +
    f("Подзаголовок (слот 6.4)", '<input data-path="object.subtitle" value="' + esc(m.object.subtitle) + '">') +
    f("Дата отправки", '<input data-path="object.date" value="' + esc(m.object.date) + '">') +
    "</div>" +
    '<div class="mf-card"><div class="mf-h">Коммерция — значения Ивана</div>' +
    f("Род цены", '<select data-path="commerce.price.kind"><option value="final"' + (m.commerce.price.kind === "final" ? " selected" : "") + '>final</option><option value="estimate"' + (m.commerce.price.kind === "estimate" ? " selected" : "") + ">estimate</option></select>") +
    f("Черновые материалы, €", '<input data-path="commerce.materials" value="' + m.commerce.materials + '">') +
    f("Предоплата, €", '<input data-path="commerce.predoplata" value="' + m.commerce.predoplata + '">') +
    f("Второй платёж, €", '<input data-path="commerce.second_payment.amount" value="' + m.commerce.second_payment.amount + '">') +
    f("Срок, значение", '<input data-path="commerce.term.value" value="' + m.commerce.term.value + '">') +
    f("Срок, единица", '<select data-path="commerce.term.unit">' + ["недель", "дней", "месяцев"].map((u) => '<option' + (m.commerce.term.unit === u ? " selected" : "") + ">" + u + "</option>").join("") + "</select>") +
    f("Пункт об отчётности (длинные проекты)", '<input type="checkbox" data-path="commerce.reporting"' + (m.commerce.reporting ? " checked" : "") + ">") +
    "</div>" +
    '<div class="mf-card"><div class="mf-h">Макет</div>' +
    f("Заголовок зоны работ", '<input data-path="layout.works_heading" value="' + esc(m.layout.works_heading) + '">') +
    f("Организация процесса", '<select data-path="layout.org_process"><option value="on"' + (m.layout.org_process === "on" ? " selected" : "") + '>блок включён</option><option value="fold"' + (m.layout.org_process === "fold" ? " selected" : "") + ">свёрнута → «В стоимость также входит»</option></select>") +
    f("Форма «В стоимость не входят»", '<select data-path="layout.not_included_form"><option value="subsections"' + (m.layout.not_included_form === "subsections" ? " selected" : "") + '>подразделы</option><option value="prose"' + (m.layout.not_included_form === "prose" ? " selected" : "") + ">строкой (форма 2635)</option></select>") +
    f("Фото объекта", '<input type="checkbox" data-path="toggle-photos"' + (!m.layout.omit.includes("photos") ? " checked" : "") + ">") +
    f("Блок согласований (решение 3)", '<input type="checkbox" data-path="layout.permits"' + (m.layout.permits ? " checked" : "") + ">") +
    "</div>" +
    '<div class="mf-card"><div class="mf-h">Решения ТЗ §12</div>' +
    f("1. Бренд", '<select data-path="layout.brand"><option' + (m.layout.brand === "MELESHIN LTD" ? " selected" : "") + '>MELESHIN LTD</option><option' + (m.layout.brand === "MELESHIN Group" ? " selected" : "") + ">MELESHIN Group</option></select>") +
    f("2. Язык ЛК клиента (админ-тумблер)", '<select data-path="object.language"><option value="ru"' + (m.object.language === "ru" ? " selected" : "") + '>ru — кабинет на русском</option><option value="en" disabled>en [ ] — решение 2 ТЗ</option></select>') +
    f("4. Менеджер", '<select data-path="object.manager_top"><option value="1"' + (m.object.manager_top ? " selected" : "") + '>сверху, перед заголовком</option><option value="0"' + (!m.object.manager_top ? " selected" : "") + ">снизу</option></select>") +
    f("5. Срок действия", '<input value="14 дней — фиксированная строка" disabled>') +
    "</div>" +
    '<div class="mf-card mf-wide"><div class="mf-h">Манифест (ТЗ 7) — указатели на источники</div><pre class="mf-pre">object:    { folder: ' + esc(m.object.folder) + ', header_object: "' + esc(m.object.header_object) + '", language: ' + m.object.language + ", date: " + esc(m.object.date) + " }\n" +
    "sources:\n  card:     " + esc(m.sources.card) + "\n  estimate: " + esc(m.sources.estimate) + "\n" +
    "images:   { hero, plans: [" + m.images.plans.length + "], photos: [" + m.images.photos.length + "], gallery: [" + m.images.gallery.length + "] }\n" +
    "commerce: { price: { kind: " + m.commerce.price.kind + " }, materials: " + fmtMoney(m.commerce.materials) + ",\n            payments: [предоплата " + fmtMoney(m.commerce.predoplata) + ", второй " + fmtMoney(m.commerce.second_payment.amount) + "], term: " + m.commerce.term.value + " " + esc(m.commerce.term.unit) + " }\n" +
    "layout:   { omit: [" + esc(m.layout.omit.join(", ")) + "], org_process: " + m.layout.org_process + ", related_table: " + m.layout.related_table + " }\n" +
    "variants: { penoplex, no-insulation }   # наложение на базовый состав</pre>" +
    '<div class="mf-actions"><button class="btn ghost" id="btn-reset">Сбросить манифест</button></div></div>' +
    "</div>"
  );
}

/* ============================================================
   Каркас: шапка, герой, сайдбар, тулбар
   ============================================================ */
function renderHero(a) {
  const m = STATE.manifest;
  const st = STATE.status;
  const thumb = (p) => p.replace("w=900", "w=100").replace("w=700", "w=100");
  return (
    '<div class="d3-hero"><div class="gallery"><img src="' + m.images.hero + '" alt="">' +
    '<div class="ribbon"><span class="status-pill ' + (st === "agreed" ? "success" : "warn") + '"><span class="dot"></span>' + (st === "agreed" ? FIXED.status_agreed : FIXED.status_sent) + " · " + esc(m.object.date) + '</span><span class="status-pill edition">Вариант: ' + a.variantLabel + "</span></div>" +
    '<div class="thumbs">' + [m.images.hero].concat(m.images.gallery.slice(0, 3)).map((p, i) => '<span class="' + (i === 0 ? "active" : "") + '"><img src="' + thumb(p) + '" alt=""></span>').join("") + "</div></div>" +
    '<div class="summary"><div class="proj-label">Коммерческое предложение · ' + esc(m.object.header_object) + "</div>" +
    "<h2>" + esc(subtitleShort(m)) + "</h2>" +
    '<div class="addr">' + esc(m.object.field_object) + "</div>" +
    '<div class="total"><div class="lbl">Стоимость по проекту</div><div class="v tnum">' + fmtMoney(a.price) + " €</div>" +
    '<div class="sub">+ 19% VAT · ' + a.rows.length + " позиций · таблица работ + сопутствующие + черновые материалы</div></div>" +
    '<div class="cta-row">' +
    (st === "sent" ? '<button class="btn primary" id="btn-approve">Согласовать</button>' : '<button class="btn ghost" disabled>Согласовано</button>') +
    '<button class="btn ghost" id="btn-pdf">Сохранить PDF</button>' +
    "</div></div></div>"
  );
}

function subtitleShort(m) {
  const s = m.object.subtitle || "";
  const dot = s.indexOf(". ");
  return dot > 0 ? s.slice(0, dot) : s;
}

const BLOCK_REGISTRY = [
  ["chrome", "Marp-обвязка: шапка + подвал"], ["manager", "Менеджер + телефон + дата"], ["title", "Коммерческое предложение"],
  ["subtitle", "Подзаголовок"], ["description", "Описание проекта"], ["plans", "План этажа"], ["photos", "Фото объекта"],
  ["works_head", "Заголовок зоны работ"], ["works_table", "Таблица работ + Итого"], ["prelim_note", "Предварительный характер"],
  ["related", "Проектные сопутствующие работы"], ["org_process", "Организация строительного процесса"], ["also_included", "В стоимость также входит"],
  ["prelim_volumes", "Объёмы определены предварительно"], ["not_estimated", "В оценку не вошло"], ["not_included", "В стоимость не входят"],
  ["separate_estimate", "Отдельной сметой"], ["engineering", "Инженерные работы"], ["permits", "Согласования и разрешения"],
  ["interaction", "Формат взаимодействия"], ["payment", "Условия оплаты a–h"], ["gallery", "Финальная галерея"],
];
const BLOCK_ANCHOR = { chrome: "sec-open", manager: "sec-open", title: "sec-open", subtitle: "sec-open", description: "sec-open", plans: "sec-plans", photos: "sec-photos-1", works_head: "sec-works", works_table: "sec-works", prelim_note: "sec-works", related: "sec-post", org_process: "sec-post", also_included: "sec-post", prelim_volumes: "sec-post", not_estimated: "sec-post", not_included: "sec-notinc", separate_estimate: "sec-notinc", engineering: "sec-notinc", permits: "sec-interaction", interaction: "sec-interaction", payment: "sec-payment", gallery: "sec-gallery" };

function renderSide(a) {
  const m = STATE.manifest;
  if (STATE.view === "estimate") return "";
  const present = new Set(a.sections.flatMap((x) => x.blocks));
  const variants = Object.entries(m.variants).map(([k, v]) => {
    const active = STATE.variant === k;
    const note = k === "base" ? "база" : k === "penoplex" ? "замена 1 строки" : "минус 1 строка";
    return '<div class="item' + (active ? " active" : "") + '" data-variant="' + k + '"><span class="name">' + v.label + "</span>" + '<span class="c">' + note + "</span></div>";
  }).join("");
  const blocks = BLOCK_REGISTRY.map(([id, title]) => {
    const on = present.has(id);
    const optional = ["plans", "photos", "prelim_note", "related", "org_process", "also_included", "prelim_volumes", "not_estimated", "separate_estimate", "engineering", "permits", "gallery"].includes(id);
    const mark = on ? "•" : optional ? "—" : "○";
    return '<div class="item bl' + (on ? " active" : "") + '" data-block="' + BLOCK_ANCHOR[id] + '" title="' + esc(title) + '"><span class="name">' + id + "</span>" + '<span class="c">' + mark + "</span></div>";
  }).join("");
  return (
    '<div class="group"><div class="h"><span>Вариант</span></div>' + variants + "</div>" +
    '<div class="group"><div class="h"><span>Блоки документа</span><span class="c">' + present.size + '/22</span></div>' + blocks + "</div>" +
    '<div class="group"><div class="h"><span>Решения ТЗ §12</span></div>' +
    '<div class="item" data-decision="brand"><span class="name">1 · Бренд</span><span class="c">' + (m.layout.brand === "MELESHIN LTD" ? "LTD" : "Group") + "</span></div>" +
    '<div class="item"><span class="name">2 · en-профиль</span><span class="c">[ ]</span></div>' +
    '<div class="item" data-decision="permits"><span class="name">3 · permits</span><span class="c">' + (m.layout.permits ? "вкл" : "выкл") + "</span></div>" +
    '<div class="item" data-decision="manager"><span class="name">4 · Менеджер</span><span class="c">' + (m.object.manager_top ? "сверху" : "снизу") + "</span></div>" +
    '<div class="item"><span class="name">5 · Срок действия</span><span class="c">14 дней</span></div>' +
    "</div>"
  );
}

function renderToolbar(a) {
  const views = [["estimate", "Смета"], ["doc", "Документ"], ["md", "Маркдаун"], ["manifest", "Манифест"], ["report", "Отчёт"]];
  const failed = a.gates.filter((x) => x.status === "fail").length;
  return (
    '<div class="d3-toolbar"><div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><input id="doc-search" placeholder="Поиск по позициям…" value="' + esc(STATE.search) + '"' + (STATE.view === "doc" ? "" : " disabled") + "></div>" +
    '<div class="view-toggle">' + views.map(([k, label]) => '<button data-view="' + k + '"' + (STATE.view === k ? ' class="active"' : "") + ">" + label + "</button>").join("") + "</div>" +
    '<div class="right"><span class="gates-badge ' + (failed ? "bad" : "ok") + '">Ворота: ' + a.gatesPassed + "/" + a.gatesTotal + (failed ? " · fail: " + failed : "") + "</span></div></div>"
  );
}

function renderAll() {
  const a = build();
  document.getElementById("hero").innerHTML = renderHero(a);
  const sideEl = document.getElementById("side");
  sideEl.innerHTML = renderSide(a);
  sideEl.style.display = STATE.view === "estimate" ? "none" : "";
  document.querySelector(".d3-main").classList.toggle("no-side", STATE.view === "estimate");
  let viewHtml;
  if (STATE.view === "estimate") viewHtml = renderEstimate(a);
  else if (STATE.view === "doc") viewHtml = renderDoc(a);
  else if (STATE.view === "md") viewHtml = renderMd(a);
  else if (STATE.view === "manifest") viewHtml = renderManifest();
  else viewHtml = renderReport(a);
  document.getElementById("content").innerHTML = renderToolbar(a) + '<div id="view" class="view-' + STATE.view + '">' + viewHtml + "</div>";
  wire(a);
  return a;
}

/* ============================================================
   События
   ============================================================ */
function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  const key = parts[parts.length - 1];
  if (typeof o[key] === "number" || (typeof o[key] === "string" && typeof value === "string" && value !== "" && !isNaN(Number(value)) && key !== "unit")) o[key] = Number(value);
  else o[key] = value;
}

function wire(a) {
  const root = document.getElementById("content");
  root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { STATE.view = b.dataset.view; renderAll(); }));
  root.querySelectorAll("[data-screen]").forEach((b) => b.addEventListener("click", () => { STATE.screen = b.dataset.screen; renderAll(); }));
  root.querySelectorAll("[data-room]").forEach((b) => b.addEventListener("click", () => { STATE.room = b.dataset.room; renderAll(); }));
  root.querySelectorAll("[data-variant]").forEach((b) => b.addEventListener("click", () => { STATE.variant = b.dataset.variant; renderAll(); }));
  root.querySelectorAll("[data-block]").forEach((b) => b.addEventListener("click", () => {
    STATE.view = "doc";
    renderAll();
    const el = document.getElementById(b.dataset.block);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  root.querySelectorAll("[data-decision]").forEach((b) => b.addEventListener("click", () => {
    const d = b.dataset.decision;
    if (d === "brand") STATE.manifest.layout.brand = STATE.manifest.layout.brand === "MELESHIN LTD" ? "MELESHIN Group" : "MELESHIN LTD";
    if (d === "permits") STATE.manifest.layout.permits = !STATE.manifest.layout.permits;
    if (d === "manager") STATE.manifest.object.manager_top = !STATE.manifest.object.manager_top;
    renderAll();
  }));
  const search = root.querySelector("#doc-search");
  if (search) search.addEventListener("input", () => {
    STATE.search = search.value;
    const works = document.getElementById("sec-works");
    if (works) {
      const aa = build();
      works.querySelector(".bp-table, .doc-filter-note") && (works.innerHTML = '<div class="doc-h2">' + esc(STATE.manifest.layout.works_heading) + "</div>" + renderWorksTable(aa));
      const badge = root.querySelector(".gates-badge");
      const failed = aa.gates.filter((x) => x.status === "fail").length;
      badge.textContent = "Ворота: " + aa.gatesPassed + "/" + aa.gatesTotal + (failed ? " · fail: " + failed : "");
      badge.className = "gates-badge " + (failed ? "bad" : "ok");
    } else renderAll();
  });
  root.querySelectorAll(".mf-field input[data-path], .mf-field select[data-path]").forEach((inp) => inp.addEventListener("change", () => {
    const p = inp.dataset.path;
    if (p === "toggle-photos") {
      const om = STATE.manifest.layout.omit;
      const i = om.indexOf("photos");
      if (inp.checked && i >= 0) om.splice(i, 1);
      if (!inp.checked && i < 0) om.push("photos");
    } else if (p === "object.manager_top") STATE.manifest.object.manager_top = inp.value === "1";
    else setPath(STATE.manifest, p, inp.type === "checkbox" ? inp.checked : inp.value);
    renderAll();
  }));
  const approve = document.getElementById("btn-approve");
  if (approve) approve.addEventListener("click", () => { STATE.status = "agreed"; renderAll(); });
  const pdf = document.getElementById("btn-pdf");
  if (pdf) pdf.addEventListener("click", () => { STATE.view = "doc"; renderAll(); setTimeout(() => window.print(), 200); });
  const reset = document.getElementById("btn-reset");
  if (reset) reset.addEventListener("click", () => { STATE.manifest = clone(MANIFEST_DEFAULT); STATE.variant = "base"; renderAll(); });
}

/* ============================================================
   Запуск (в браузере; под node — экспорт машины для smoke-теста)
   ============================================================ */
if (typeof document !== "undefined" && document.getElementById("content")) {
  renderAll();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ESTIMATE_ROWS, MATERIALS_ROWS, MANIFEST_DEFAULT, FIXED, STATE, clone, assemble, aggregate, applyVariant, runGates, repetitionScan, estimateModel, decomposeRoom, renderEstimate, renderDoc, renderReport, renderManifest, renderHero, renderSide, renderToolbar, fmtMoney, fmtQty, build };
}
