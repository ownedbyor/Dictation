// Fixed speech phrases for the natural (server) voice.
// The exact text of each phrase is the cache key of its pre-rendered clip in Supabase Storage
// (see supabase/functions/dictation-tts). If you change a phrase, re-run `node tools/warm-phrases.mjs`.
// Hebrew letter names carry full niqqud so the voice reads them correctly (עַיִן, not "אין").
(function (root) {
  var LNQ = {
    'א': 'אָלֶף', 'ב': 'בֵּית', 'ג': 'גִּימֶל', 'ד': 'דָּלֶת', 'ה': 'הֵא', 'ו': 'וָו', 'ז': 'זַיִן', 'ח': 'חֵית',
    'ט': 'טֵית', 'י': 'יוֹד', 'כ': 'כָּף', 'ך': 'כָּף סוֹפִית', 'ל': 'לָמֶד', 'מ': 'מֵם', 'ם': 'מֵם סוֹפִית',
    'נ': 'נוּן', 'ן': 'נוּן סוֹפִית', 'ס': 'סָמֶךְ', 'ע': 'עַיִן', 'פ': 'פֵּא', 'ף': 'פֵּא סוֹפִית', 'צ': 'צָדִי',
    'ץ': 'צָדִי סוֹפִית', 'ק': 'קוֹף', 'ר': 'רֵישׁ', 'ש': 'שִׁין', 'ת': 'תָּו'
  };
  // English letter names as Hebrew speakers say them, with niqqud, so English corrections can be spoken in Hebrew.
  var ENQ = {
    a: 'אֵיי', b: 'בִּי', c: 'סִי', d: 'דִּי', e: 'אִי', f: 'אֶף', g: "גִ'י", h: "אֵייצ'", i: 'אַיי', j: "גֵ'יי",
    k: 'קֵיי', l: 'אֶל', m: 'אֶם', n: 'אֶן', o: 'אוֹ', p: 'פִּי', q: 'קְיוּ', r: 'אָר', s: 'אֶס', t: 'טִי',
    u: 'יוּ', v: 'וִי', w: 'דַּאבֶּל יוּ', x: 'אֶקְס', y: 'וַואי', z: 'זֶד'
  };
  var FINALS = 'ךםןףץ';
  var ABC = 'abcdefghijklmnopqrstuvwxyz';

  var PH = {
    LNQ: LNQ,
    ENQ: ENQ,
    he: {
      write: function (c) { return 'כּוֹתְבִים ' + LNQ[c] + '.'; },
      not: function (c) { return 'וְלֹא ' + LNQ[c] + '.'; },
      starts: function (c) { return 'הַמִּלָּה מַתְחִילָה בָּאוֹת ' + LNQ[c] + '.'; },
      letter: function (c) { return LNQ[c] + '.'; },
      spellIntro: 'כּוֹתְבִים כָּךְ:',
      // English corrections, spoken in Hebrew: "כּוֹתְבִים" + (English word) + "עִם אִי," + "וְלֹא עִם אֵיי."
      writes: 'כּוֹתְבִים',
      withEn: function (c) { return 'עִם ' + ENQ[c] + ','; },
      notWithEn: function (c) { return 'וְלֹא עִם ' + ENQ[c] + '.'; },
      enLetter: function (c) { return ENQ[c] + '.'; },
      enStarts: function (c) { return 'הַמִּלָּה מַתְחִילָה בָּאוֹת ' + ENQ[c] + '.'; },
      almost: 'כִּמְעַט!',
      look: 'כִּמְעַט! תִּסְתַּכְּלִי עַל הָאוֹתִיּוֹת הָאֲדֻמּוֹת.',
      done: 'סִיַּמְתְּ! כׇּל הַכָּבוֹד!',
      test: 'שָׁלוֹם! אֲנִי אַקְרִיא לָךְ אֶת הַמִּלִּים בַּהַכְתָּבָה.',
      praise: ['מְצֻיָּן!', 'כׇּל הַכָּבוֹד!', 'יָפֶה מְאוֹד!', 'נָכוֹן!', 'אַלּוּפָה!', 'בְּדִיּוּק כָּכָה!']
    },
    en: {
      write: function (c) { return 'Write ' + c + '.'; },
      not: function (c) { return 'Not ' + c + '.'; },
      starts: function (c) { return 'It starts with the letter ' + c + '.'; },
      word: function (w) { return w + '.'; },
      spelled: function (w) { return w + ' is spelled: ' + w.split('').join(', ') + '.'; },
      almost: 'Almost!',
      look: 'Almost! Look at the red letters.',
      praise: ['Great!', 'Well done!', 'Excellent!', 'Perfect!', 'Super!', 'Good job!']
    },
    // The clip read for every dictation item: word, sentence, word. Uses the niqqud versions (wn / sn) when present.
    item: function (it) { var w = it.wn || it.w; return w + '. ' + (it.sn || it.s) + ' ' + w + '.'; },
    // Every fixed clip, for pre-rendering. enItems = the English word bank.
    all: function (enItems) {
      var out = [], he = PH.he, en = PH.en;
      Object.keys(LNQ).forEach(function (c) {
        out.push({ text: he.letter(c), lang: 'he' }, { text: he.write(c), lang: 'he' }, { text: he.not(c), lang: 'he' });
        if (FINALS.indexOf(c) < 0) { out.push({ text: he.starts(c), lang: 'he' }); }
      });
      [he.almost, he.spellIntro, he.done, he.test].concat(he.praise).forEach(function (t) { out.push({ text: t, lang: 'he' }); });
      out.push({ text: he.writes, lang: 'he' });
      ABC.split('').forEach(function (c) {
        out.push({ text: he.enLetter(c), lang: 'he' }, { text: he.withEn(c), lang: 'he' }, { text: he.notWithEn(c), lang: 'he' }, { text: he.enStarts(c), lang: 'he' });
      });
      en.praise.forEach(function (t) { out.push({ text: t, lang: 'en' }); });
      (enItems || []).forEach(function (it) {
        out.push({ text: PH.item(it), lang: 'en' }, { text: en.word(it.w), lang: 'en' });
      });
      return out;
    }
  };
  root.PH = PH;
})(typeof window !== 'undefined' ? window : globalThis);
