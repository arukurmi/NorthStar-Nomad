export interface Holiday {
  /** ISO date YYYY-MM-DD */
  date: string;
  name: string;
}

/** Indian public holidays, 2026–2027 (major gazetted + widely observed). */
export const holidays: Holiday[] = [
  { date: "2026-01-26", name: "Republic Day" },
  { date: "2026-03-04", name: "Holi" },
  { date: "2026-03-21", name: "Eid al-Fitr" },
  { date: "2026-04-03", name: "Good Friday" },
  { date: "2026-05-01", name: "Buddha Purnima" },
  { date: "2026-05-27", name: "Eid al-Adha" },
  { date: "2026-08-15", name: "Independence Day" },
  { date: "2026-08-28", name: "Raksha Bandhan" },
  { date: "2026-09-04", name: "Janmashtami" },
  { date: "2026-10-02", name: "Gandhi Jayanti" },
  { date: "2026-10-20", name: "Dussehra" },
  { date: "2026-11-08", name: "Diwali" },
  { date: "2026-11-09", name: "Govardhan Puja" },
  { date: "2026-11-24", name: "Guru Nanak Jayanti" },
  { date: "2026-12-25", name: "Christmas" },
  { date: "2027-01-26", name: "Republic Day" },
  { date: "2027-03-22", name: "Holi" },
  { date: "2027-03-26", name: "Good Friday" },
  { date: "2027-08-15", name: "Independence Day" },
  { date: "2027-10-02", name: "Gandhi Jayanti" },
  { date: "2027-10-09", name: "Dussehra" },
  { date: "2027-10-29", name: "Diwali" },
  { date: "2027-12-25", name: "Christmas" },
];

export const holidayByDate = new Map(holidays.map((h) => [h.date, h.name]));
