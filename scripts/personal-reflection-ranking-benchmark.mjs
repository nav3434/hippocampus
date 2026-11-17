import fs from 'node:fs';
import { pipeline } from '@huggingface/transformers';

const corpus = [
  ['T01','Стоимость потребленной электроэнергии определяют по разнице текущего и прошлого значения прибора учета, умноженной на тариф.'],
  ['T02','Отчет о доходах физического лица передают в налоговый орган не позднее установленной даты и сохраняют подтверждение приема.'],
  ['T03','Источник питания автомобиля на морозе может потерять емкость, поэтому перед зимой проверяют заряд и напряжение под нагрузкой.'],
  ['T04','После осадков влагу в помещении связывают с повреждением кровельного покрытия и проверяют примыкания на крыше.'],
  ['T05','Для нормализации ночного отдыха вечером уменьшают воздействие яркого экрана и придерживаются постоянного времени отхода ко сну.'],
  ['T06','Издание, полученное во временное пользование, необходимо сдать в учреждение до установленного срока, чтобы избежать просрочки.'],
  ['T07','Документ гражданина для пересечения государственной границы заканчивает действие в июле следующего года.'],
  ['T08','Резкая реакция эмали на холодное или горячее является поводом для стоматологического осмотра.'],
  ['T09','Освободить дисковое пространство контейнерной среды можно удалением неиспользуемого кэша сборки и образов с сохранением рабочих томов.'],
  ['T10','Краткоживущие учетные данные клиента перестают приниматься сервером после завершения срока действия и требуют обновления.'],
  ['T11','Смысловую близость фрагментов текста можно оценивать по косинусу между их векторными представлениями.'],
  ['T12','Если вода остается в барабане после программы, проверяют засор сливного тракта и очищают фильтрующий элемент насоса.'],
  ['T13','Минеральный налет внутри нагревательного сосуда удаляют слабым раствором лимонной кислоты и затем тщательно промывают.'],
  ['T14','До распускания почек у плодового дерева удаляют сухие, поврежденные и пересекающиеся ветви.'],
  ['T15','Договор страховой защиты нужно продлить до завершения срока действия текущего полиса.'],
  ['T16','После нагрузки на плечевой сустав допустима мягкая мобилизация в безболезненном диапазоне без резких движений.'],
  ['T17','Вход на выбранный музейный сеанс лучше бронировать заранее, чтобы не зависеть от очереди в кассе.'],
  ['T18','Домашнему псу ежегодную иммунизацию проводят после ветеринарного осмотра и оценки общего состояния.'],
  ['T19','Плата за обслуживание банковской карты списывается, если клиент не выполнил условия бесплатного тарифного плана.'],
  ['T20','Перед изменением программы или схемы данных необходимо сохранить резерв базы и проверить возможность восстановления.'],
  ['D01','Показания счетчика воды передают ежемесячно, а сумму рассчитывают по разнице кубометров и действующему тарифу.'],
  ['D02','Газовый счетчик фиксирует расход топлива, по которому затем рассчитывается ежемесячный платеж.'],
  ['D03','Счетчик электроэнергии подлежит замене при неисправности или окончании межповерочного интервала.'],
  ['D04','Таможенная декларация содержит сведения о перемещаемых через границу товарах и их стоимости.'],
  ['D05','Справка о доходах подтверждает начисленные выплаты и удержанный налог за отчетный период.'],
  ['D06','Квитанцию об уплате налога сохраняют как подтверждение исполнения платежного обязательства.'],
  ['D07','Аккумулятор смартфона быстрее разряжается при высокой яркости экрана и активной передаче данных.'],
  ['D08','Батарея источника бесперебойного питания требует замены, когда резко падает время автономной работы.'],
  ['D09','Автомобильный генератор должен поддерживать заряд аккумулятора при работающем двигателе.'],
  ['D10','Протечка водопроводной трубы определяется по мокрым соединениям и падению давления в системе.'],
  ['D11','Конденсат на окне появляется при высокой влажности воздуха и холодной поверхности стекла.'],
  ['D12','Засор водосточного желоба мешает отводу дождевой воды с крыши и требует очистки.'],
  ['D13','Уведомления телефона ночью мешают отдыху, поэтому их отключают на время сна.'],
  ['D14','Печатную книгу можно купить в магазине или заказать с доставкой по каталогу.'],
  ['D15','Подписка на электронную библиотеку открывает доступ к книгам на ограниченный оплаченный период.'],
  ['D16','Внутренний паспорт меняют при достижении установленного возраста или изменении персональных данных.'],
  ['D17','Виза имеет собственный срок действия и может требовать нового оформления для следующей поездки.'],
  ['D18','Боль в горле от холодного напитка обычно связана с раздражением слизистой, а не с состоянием зубов.'],
  ['D19','Рабочие Docker volumes содержат данные приложений и перед очисткой среды требуют отдельной резервной копии.'],
  ['D20','Большие журнальные файлы могут заполнить системный диск, поэтому их размер и ротацию контролируют отдельно.'],
  ['D21','JWT проверяют по подписи, аудитории и времени истечения перед предоставлением доступа к API.'],
  ['D22','Отозванный API-ключ больше не дает права вызывать защищенный сервис даже при правильном формате запроса.'],
  ['D23','Точный поиск по ключевым словам сравнивает текстовые токены и не требует вычисления семантических векторов.'],
  ['D24','Кластеризация эмбеддингов группирует близкие объекты без заранее заданной метки класса.'],
  ['D25','Если посудомоечная машина не сливает воду, очищают ее фильтр и проверяют сливной шланг.'],
  ['D26','Кофемашину очищают от известковых отложений специальным средством по программе декальцинации.'],
  ['D27','Вишневое дерево обрезают с учетом плодоношения и состояния скелетных ветвей.'],
  ['D28','После нагрузки на коленный сустав полезны спокойные упражнения на подвижность без боли.'],
  ['D29','Авиабилеты на популярный рейс часто выгоднее покупать заранее до повышения тарифа.'],
  ['D30','Комиссия за банковский перевод зависит от направления платежа и условий тарифа клиента.']
].map(([id,text])=>({id,text}));

const queries = [
  ['Q01','paraphrase','как посчитать оплату за свет по старым и новым цифрам счетчика','T01'],
  ['Q02','paraphrase','до какого числа сдавать декларацию о доходах в налоговую','T02'],
  ['Q03','paraphrase','в мороз машина не заводится потому что сел аккумулятор','T03'],
  ['Q04','paraphrase','после дождя протекает крыша и намок потолок','T04'],
  ['Q05','paraphrase','как лучше спать если вечером долго смотрю в телефон','T05'],
  ['Q06','paraphrase','когда нужно вернуть библиотечную книгу чтобы не было просрочки','T06'],
  ['Q07','paraphrase','когда заканчивается загранпаспорт для поездок за границу','T07'],
  ['Q08','paraphrase','зуб резко реагирует на холодное что проверить у стоматолога','T08'],
  ['Q09','paraphrase','как почистить docker и освободить диск не удаляя рабочие volumes','T09'],
  ['Q10','paraphrase','oauth токен протух и сервер больше не принимает запросы','T10'],
  ['Q11','paraphrase','как найти похожие по смыслу тексты через embeddings','T11'],
  ['Q12','paraphrase','стиралка закончила программу но не слила воду','T12'],
  ['Q13','paraphrase','чем убрать накипь внутри электрического чайника','T13'],
  ['Q14','paraphrase','когда весной обрезать яблоню и какие ветки удалить','T14'],
  ['Q15','paraphrase','страховка скоро закончится когда оформить продление','T15'],
  ['Q16','paraphrase','после тренировки тянет плечо какие движения делать осторожно','T16'],
  ['Q17','paraphrase','билеты в музей лучше взять заранее на определенное время','T17'],
  ['Q18','paraphrase','собаке нужна ежегодная прививка после осмотра врача','T18'],
  ['Q19','paraphrase','почему банк списал комиссию за обслуживание карты','T19'],
  ['Q20','paraphrase','перед обновлением программы сделать копию базы и проверить восстановление','T20']
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

const results={benchmark:'personal-reflection-russian-dense-stress-v1',production_changed:false,corpus_count:corpus.length,query_count:queries.length,models:{}};
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