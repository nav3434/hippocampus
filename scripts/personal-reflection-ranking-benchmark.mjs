import fs from 'node:fs';
import { pipeline } from '@huggingface/transformers';

const corpus = [
  ['S01','Перед зимой аккумулятор автомобиля нужно полностью зарядить и проверить напряжение под нагрузкой.'],
  ['S02','Если тормозные колодки начали скрипеть и толщина накладки мала, их следует заменить.'],
  ['S03','Моторное масло меняют вместе с фильтром после установленного пробега или срока эксплуатации.'],
  ['S04','Давление в шинах проверяют на холодных колесах и корректируют по табличке автомобиля.'],
  ['S05','Томатный суп получается ароматнее, если добавить базилик после измельчения помидоров.'],
  ['S06','Гречку с грибами готовят с обжаренным луком, затем добавляют крупу и воду.'],
  ['S07','Закваску для хлеба подкармливают мукой и водой до заметного увеличения объема.'],
  ['S08','Кофейную мельницу очищают от старых зерен и настраивают помол под способ заваривания.'],
  ['S09','Рейс в Казань перенесли на вечер, поэтому время выезда в аэропорт нужно изменить.'],
  ['S10','Поезд до Пскова отправляется утром, посадка начинается заранее у указанной платформы.'],
  ['S11','В гостинице заселение начинается после четырнадцати часов, нужен документ удостоверяющий личность.'],
  ['S12','Срок действия заграничного паспорта заканчивается в июле следующего года.'],
  ['S13','Налоговую декларацию нужно подать до установленной законом даты и сохранить подтверждение отправки.'],
  ['S14','Плату за электричество сверяют по текущим и предыдущим показаниям счетчика и тарифу.'],
  ['S15','Счет за аренду помещения выставляется ежемесячно с указанием периода и суммы платежа.'],
  ['S16','Банк удерживает комиссию за обслуживание карты только при невыполнении условий бесплатного тарифа.'],
  ['S17','При повышенной чувствительности зуба стоит записаться к стоматологу для осмотра эмали и десен.'],
  ['S18','После нагрузки на плечо полезны мягкие упражнения на подвижность без резкой боли.'],
  ['S19','Для улучшения сна вечером стоит уменьшить яркость экрана и соблюдать постоянное время отхода ко сну.'],
  ['S20','Плавательную тренировку удобно строить из разминки, нескольких серий и спокойной заминки.'],
  ['S21','Яблоню лучше обрезать ранней весной до распускания почек, удаляя сухие и пересекающиеся ветви.'],
  ['S22','В теплице огурцам нужен регулярный полив теплой водой и проветривание без сильного сквозняка.'],
  ['S23','После дождя протечку кровли ищут по влажным следам и проверяют примыкания и поврежденное покрытие.'],
  ['S24','Перед отопительным сезоном котел очищают, проверяют давление и работу защитной автоматики.'],
  ['S25','Перед обновлением программы нужно сделать резервную копию базы данных и проверить возможность восстановления.'],
  ['S26','Если срок действия токена OAuth закончился, запросы авторизации перестают проходить до получения нового токена.'],
  ['S27','Семантический поиск похожих текстов строится на эмбеддингах и сравнении векторов по косинусной близости.'],
  ['S28','Чтобы освободить место Docker, сначала проверяют неиспользуемые образы и кэш сборки, не удаляя рабочие тома.'],
  ['S29','На занятиях испанским полезно повторять новые слова в коротких фразах и регулярно слушать речь.'],
  ['S30','При занятиях на пианино сложный фрагмент разучивают медленно отдельными руками, затем соединяют.'],
  ['S31','Книгу из библиотеки необходимо вернуть до конца месяца, чтобы не возникла просрочка.'],
  ['S32','Для съемки портрета объектив с умеренным фокусным расстоянием помогает избежать сильных искажений лица.'],
  ['S33','Родительское собрание в школе назначено на вечер четверга в кабинете классного руководителя.'],
  ['S34','Шахматный турнир пройдет в субботу, регистрация участников заканчивается за полчаса до начала.'],
  ['S35','Для подарка на день рождения выбрали настольную игру и небольшой набор сладостей.'],
  ['S36','Билеты в музей лучше купить заранее на выбранный сеанс, чтобы не стоять в очереди.'],
  ['S37','Собаке требуется ежегодная вакцинация после осмотра ветеринара и проверки общего состояния.'],
  ['S38','Кошачий корм меняют постепенно в течение нескольких дней, смешивая старый и новый рацион.'],
  ['S39','Фильтр аквариума промывают в слитой аквариумной воде, чтобы сохранить полезные бактерии.'],
  ['S40','Кормушку для птиц зимой наполняют семенами и регулярно очищают от снега и испорченного корма.'],
  ['S41','В счете по договору должны быть номер документа, реквизиты сторон, сумма и назначение платежа.'],
  ['S42','При подаче документов в суд важно сохранить отметку о принятии или электронную квитанцию.'],
  ['S43','Страховой полис действует до декабря, поэтому продление нужно оформить до окончания текущего срока.'],
  ['S44','Выписка о недвижимости содержит кадастровый номер, площадь объекта и сведения о зарегистрированных правах.'],
  ['S45','Если велосипедная цепь щелкает и проскакивает под нагрузкой, нужно проверить износ цепи и звезд.'],
  ['S46','Беговые кроссовки выбирают по удобству посадки, типу тренировок и достаточному запасу места для пальцев.'],
  ['S47','Перед катанием лыжи очищают и наносят подходящую мазь с учетом температуры снега.'],
  ['S48','Палатку для похода сначала собирают дома, проверяя дуги, колышки и водозащитный тент.'],
  ['S49','Накипь в электрическом чайнике можно удалить раствором лимонной кислоты с последующим тщательным полосканием.'],
  ['S50','Если стиральная машина плохо сливает воду, сначала проверяют сливной фильтр и отсутствие засора в шланге.']
].map(([id,text])=>({id,text}));

const queries = [
  ['Q01','direct','как подготовить автомобиль к морозу если аккумулятор садится','S01'],
  ['Q02','direct','когда менять тормозные колодки если появился скрип','S02'],
  ['Q03','direct','как приготовить гречку с грибами и луком','S06'],
  ['Q04','paraphrase','где записано что нужно вернуть книгу до конца месяца','S31'],
  ['Q05','paraphrase','что проверить если стиральная машина плохо сливает воду','S50'],
  ['Q06','direct','когда заканчивается загранпаспорт','S12'],
  ['Q07','direct','какой срок подачи налоговой декларации','S13'],
  ['Q08','paraphrase','как сверить плату за свет по показаниям прибора учета','S14'],
  ['Q09','paraphrase','что делать с протечкой крыши после дождя','S23'],
  ['Q10','direct','резервная копия базы перед обновлением программы','S25'],
  ['Q11','paraphrase','почему авторизация перестала работать после истечения ключа доступа','S26'],
  ['Q12','paraphrase','поиск похожих текстов с помощью векторных представлений','S27'],
  ['Q13','paraphrase','как освободить место в docker не удаляя рабочие данные','S28'],
  ['Q14','direct','запись к стоматологу из-за чувствительности зуба','S17'],
  ['Q15','paraphrase','как лучше спать если вечером долго смотрю в экран','S19'],
  ['Q16','direct','обрезка яблони весной до распускания почек','S21'],
  ['Q17','paraphrase','страховка заканчивается в декабре когда нужно продлевать','S43'],
  ['Q18','paraphrase','нужен документ с кадастровым номером и площадью объекта','S44'],
  ['Q19','paraphrase','цепь велосипеда щелкает и перескакивает при нагрузке','S45'],
  ['Q20','direct','чем убрать накипь в электрическом чайнике','S49']
].map(([id,type,text,target])=>({id,type,text,target}));

const models = [
  {key:'current', name:'Xenova/all-MiniLM-L6-v2'},
  {key:'multilingual', name:'Xenova/paraphrase-multilingual-MiniLM-L12-v2'}
];

function dot(a,b){ let s=0; for(let i=0;i<a.length;i++) s += a[i]*b[i]; return s; }

async function embedBatches(extractor, texts, batchSize=8){
  const rows=[];
  for(let i=0;i<texts.length;i+=batchSize){
    const batch=texts.slice(i,i+batchSize);
    const out=await extractor(batch,{pooling:'mean',normalize:true});
    const vals=out.tolist();
    for(const row of vals) rows.push(row);
  }
  return rows;
}

function rankQueries(corpusVectors, queryVectors){
  return queries.map((q,qi)=>{
    const ranked=corpus.map((row,ci)=>({id:row.id, similarity:dot(queryVectors[qi],corpusVectors[ci])}))
      .sort((a,b)=>b.similarity-a.similarity);
    const idx=ranked.findIndex(r=>r.id===q.target);
    const rank=idx+1;
    return {
      id:q.id, type:q.type, target:q.target, rank,
      target_similarity: ranked[idx].similarity,
      rank20_similarity: ranked[Math.min(19,ranked.length-1)].similarity,
      top5: ranked.slice(0,5).map(r=>r.id)
    };
  });
}

function summarize(rows){
  const n=rows.length;
  const recall20=rows.filter(r=>r.rank<=20).length/n;
  const recall50=rows.filter(r=>r.rank<=50).length/n;
  const mrr=rows.reduce((s,r)=>s+1/r.rank,0)/n;
  const meanRank=rows.reduce((s,r)=>s+r.rank,0)/n;
  const sorted=rows.map(r=>r.rank).sort((a,b)=>a-b);
  const medianRank=(sorted[9]+sorted[10])/2;
  const byType={};
  for(const type of ['direct','paraphrase']){
    const rs=rows.filter(r=>r.type===type);
    byType[type]={n:rs.length,recall20:rs.filter(r=>r.rank<=20).length/rs.length,mrr:rs.reduce((s,r)=>s+1/r.rank,0)/rs.length,meanRank:rs.reduce((s,r)=>s+r.rank,0)/rs.length};
  }
  return {n,recall20,recall50,mrr,meanRank,medianRank,byType, acceptance:{direct_top20:byType.direct.recall20===1, paraphrase_top20_ge_90:byType.paraphrase.recall20>=0.9}};
}

async function runModel(spec){
  console.log(`MODEL_START ${spec.key} ${spec.name}`);
  const extractor=await pipeline('feature-extraction',spec.name,{dtype:'q8'});
  const corpusVectors=await embedBatches(extractor,corpus.map(x=>x.text));
  const q1=await embedBatches(extractor,queries.map(x=>x.text));
  const rows1=rankQueries(corpusVectors,q1);
  const q2=await embedBatches(extractor,queries.map(x=>x.text));
  const rows2=rankQueries(corpusVectors,q2);
  const deterministic=rows1.every((r,i)=>r.rank===rows2[i].rank && JSON.stringify(r.top5)===JSON.stringify(rows2[i].top5));
  const result={model:spec.name,dtype:'q8',summary:summarize(rows1),deterministic,queries:rows1};
  console.log(`MODEL_DONE ${spec.key} recall20=${result.summary.recall20.toFixed(3)} mrr=${result.summary.mrr.toFixed(3)} deterministic=${deterministic}`);
  if (typeof extractor.dispose === 'function') await extractor.dispose();
  return result;
}

const results={benchmark:'personal-reflection-russian-synthetic-v1',production_changed:false,corpus_count:corpus.length,query_count:queries.length,models:{}};
for(const spec of models) results.models[spec.key]=await runModel(spec);

const current=results.models.current.summary;
const multi=results.models.multilingual.summary;
results.comparison={
  recall20_delta:multi.recall20-current.recall20,
  mrr_delta:multi.mrr-current.mrr,
  mean_rank_delta:multi.meanRank-current.meanRank,
  current_misses_top20:results.models.current.queries.filter(q=>q.rank>20).map(q=>({id:q.id,target:q.target,rank:q.rank,type:q.type})),
  multilingual_misses_top20:results.models.multilingual.queries.filter(q=>q.rank>20).map(q=>({id:q.id,target:q.target,rank:q.rank,type:q.type}))
};

fs.writeFileSync('benchmark-results.json',JSON.stringify(results,null,2));
const md=[
  '# Personal Reflection Russian synthetic ranking benchmark',
  '',
  `Corpus: ${corpus.length}; queries: ${queries.length}; q8; mean pooling; normalized vectors; raw cosine ranking.`,
  '',
  '| Model | Recall@20 | Recall@50 | MRR | Mean rank | Direct R@20 | Paraphrase R@20 | Deterministic |',
  '|---|---:|---:|---:|---:|---:|---:|---|',
  `| all-MiniLM-L6-v2 | ${current.recall20.toFixed(3)} | ${current.recall50.toFixed(3)} | ${current.mrr.toFixed(3)} | ${current.meanRank.toFixed(2)} | ${current.byType.direct.recall20.toFixed(3)} | ${current.byType.paraphrase.recall20.toFixed(3)} | ${results.models.current.deterministic} |`,
  `| paraphrase-multilingual-MiniLM-L12-v2 | ${multi.recall20.toFixed(3)} | ${multi.recall50.toFixed(3)} | ${multi.mrr.toFixed(3)} | ${multi.meanRank.toFixed(2)} | ${multi.byType.direct.recall20.toFixed(3)} | ${multi.byType.paraphrase.recall20.toFixed(3)} | ${results.models.multilingual.deterministic} |`,
  '',
  `Recall@20 delta: ${(multi.recall20-current.recall20).toFixed(3)}`,
  `MRR delta: ${(multi.mrr-current.mrr).toFixed(3)}`,
  '',
  '## Per-query ranks',
  '',
  '| Query | Type | Target | Current rank | Multilingual rank |',
  '|---|---|---|---:|---:|',
  ...queries.map((q,i)=>`| ${q.id} | ${q.type} | ${q.target} | ${results.models.current.queries[i].rank} | ${results.models.multilingual.queries[i].rank} |`)
].join('\n');
fs.writeFileSync('benchmark-summary.md',md);
console.log(md);
console.log('BENCHMARK_JSON '+JSON.stringify(results.comparison));