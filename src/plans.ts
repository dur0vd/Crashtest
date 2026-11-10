export const BILLING = {
  contact: 'mr.cartest@mail.ru',
  plans: {
    personal: { title: 'Личная подписка', price: 199, note: 'для одного ученика на его устройствах' },
    school: { title: 'Автошкола', price: 3990, note: 'для преподавателей и всех учеников школы' },
  },
} as const;
