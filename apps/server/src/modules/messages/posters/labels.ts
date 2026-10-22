/** The few fixed words printed on a poster, in the owner's language. */
export type PosterLang = 'en' | 'el';

export interface PosterLabels {
  readonly scanToJoin: string;
  readonly clubId: string;
  readonly tournament: string;
  readonly emailSubject: string;
  readonly emailText: string;
}

export const POSTER_LABELS: Readonly<Record<PosterLang, PosterLabels>> = {
  en: {
    scanToJoin: 'Scan with your phone to join the club',
    clubId: 'Club ID',
    tournament: 'Tournament',
    emailSubject: 'Your GetFlop poster',
    emailText: 'Your poster is attached as a print-ready A4 PDF (300 dpi).',
  },
  el: {
    scanToJoin: 'Σκανάρετε με το κινητό για να μπείτε στη λέσχη',
    clubId: 'ID λέσχης',
    tournament: 'Τουρνουά',
    emailSubject: 'Η αφίσα σας από το GetFlop',
    emailText: 'Η αφίσα σας επισυνάπτεται ως PDF A4 έτοιμο για εκτύπωση (300 dpi).',
  },
};
