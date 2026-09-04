// Large pool of sample questions for 룬 뽑기. A random subset (in random
// order) is shown each time draw.html loads, mirroring color-tarot-app's
// mood-chip pattern — tap one to fill the question box.
export const QUESTION_POOL = [
  { ic: '\u{1F4BC}', text: '지금 이직을 고민하고 있어요. 지금이 움직일 때일까요?' },
  { ic: '\u{2764}️', text: '지금 만나는 사람과의 관계가 앞으로 어떻게 될까요?' },
  { ic: '\u{1F4B0}', text: '지금 큰돈을 움직여도 괜찮을까요?' },
  { ic: '\u{1F3E0}', text: '지금 이 집으로 이사하는 게 맞을까요?' },
  { ic: '\u{1F91D}', text: '이 사람을 계속 믿고 함께해도 될까요?' },
  { ic: '\u{1F331}', text: '새로운 일을 지금 시작해도 괜찮을까요?' },
  { ic: '\u{1F62B}', text: '요즘 너무 지쳐요. 지금 쉬어가도 될까요?' },
  { ic: '\u{2696}️', text: '이 갈등을 어떻게 풀어가야 할까요?' },
  { ic: '\u{1F4DA}', text: '지금 준비하는 시험, 결과가 어떻게 될까요?' },
  { ic: '\u{1F440}', text: '이 사람의 진심이 궁금해요.' },
  { ic: '\u{1F3AF}', text: '지금 목표를 향해 제대로 가고 있는 걸까요?' },
  { ic: '\u{1F6EB}', text: '이번 여행(이동), 지금 떠나도 괜찮을까요?' },
  { ic: '\u{1F48A}', text: '요즘 몸이 안 좋아요. 무엇을 돌봐야 할까요?' },
  { ic: '\u{1F440}', text: '지금 이 결정을 미루는 게 나을까요, 밀어붙이는 게 나을까요?' },
  { ic: '\u{1F46A}', text: '가족과의 갈등, 어떻게 풀어야 할까요?' },
  { ic: '\u{1F3A8}', text: '지금 준비하는 프로젝트, 계속 밀고 나가도 될까요?' },
  { ic: '\u{1F494}', text: '이 관계를 정리해야 할지 고민이에요.' },
  { ic: '\u{23F3}', text: '지금은 기다려야 할 때일까요, 움직여야 할 때일까요?' },
  { ic: '\u{1F91D}', text: '새로운 사람을 만나게 될까요?' },
  { ic: '\u{1F4C8}', text: '지금 하고 있는 일, 계속 밀고 나가도 될까요?' },
  { ic: '\u{1F3E2}', text: '지금 다니는 회사에 계속 남아야 할까요?' },
  { ic: '\u{1F331}', text: '지금 제 안에서 자라고 있는 게 뭘까요?' },
  { ic: '\u{1F937}', text: '지금 이 답답함, 어디서 오는 걸까요?' },
  { ic: '\u{2728}', text: '오늘 하루, 제가 특별히 신경 써야 할 게 있을까요?' },
  { ic: '\u{1F91D}', text: '이 사람과의 인연, 계속 이어질까요?' },
  { ic: '\u{1F4AA}', text: '지금 이 도전을 계속해도 될까요?' },
  { ic: '\u{1F3E1}', text: '지금 자리를 지켜야 할까요, 떠나야 할까요?' },
  { ic: '\u{1F5DD}️', text: '지금의 선택이 후회로 남지는 않을까요?' },
  { ic: '\u{1F3C3}', text: '너무 서두르고 있는 건 아닐까요?' },
  { ic: '\u{1F32C}️', text: '지금 이 답답한 흐름이 언제쯤 풀릴까요?' },
];

// Fisher–Yates shuffle
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pickRandomQuestions(count = 6) {
  return shuffle(QUESTION_POOL).slice(0, count);
}
