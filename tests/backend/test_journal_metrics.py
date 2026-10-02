import unittest
import journal_lookup


class JournalMetricsTest(unittest.TestCase):
    def test_public_result_keeps_cas_separate_from_new_ranking(self):
        journal={'name':'Example Journal','login_url':'https://example.test/author'}
        raw={'ok':True,'name':'Example Journal','source_url':'https://www.scholay.com/journal/1',
             'issns':['1234-5678'],'groups':[
                 {'label':'JCR · 科睿唯安','fields':{'影响因子':'7','数据年份':'2025'}},
                 {'label':'中科院基础版分区','fields':{'大类分区':'2','大类学科':'工程技术','数据年份':'2025'}},
                 {'label':'中科院新锐分区','fields':{'大类分区':'1','大类学科':'工程技术','数据年份':'2026','Top 期刊':'Top 期刊'}}]}
        record,error=journal_lookup.parse_result(journal,raw)
        self.assertFalse(error)
        self.assertEqual(record['cas']['zone'],2)
        self.assertEqual(record['cas']['year'],2025)
        self.assertFalse(record['cas']['top'])
        self.assertEqual(record['impact_factor']['value'],'7.0')
        self.assertEqual(record['impact_factor']['year'],2025)
        raw['name']='Example Journal of Another Discipline'
        self.assertEqual(journal_lookup.parse_result(journal,raw)[0],{})

    def test_older_lookup_preserves_verified_metric_but_new_year_updates(self):
        seed={'impact_factor':{'value':'7.0','year':2025,'source_name':'Publisher'}}
        cached={'impact_factor':{'value':'5.9','year':2024,'source_name':'Scholay（公开转录）'}}
        self.assertEqual(journal_lookup.merge_metrics(seed,cached)['impact_factor'],seed['impact_factor'])
        cached['impact_factor'].update(value='7.2',year=2026)
        self.assertEqual(journal_lookup.merge_metrics(seed,cached)['impact_factor'],cached['impact_factor'])

    def test_missing_year_is_not_assumed(self):
        journal={'name':'Example Journal','login_url':'https://example.test/author'}
        raw={'ok':True,'name':'Example Journal','source_url':'https://www.scholay.com/journal/1',
             'groups':[{'label':'JCR','fields':{'影响因子':'4.5'}}]}
        record,error=journal_lookup.parse_result(journal,raw)
        self.assertNotIn('impact_factor',record)
        self.assertIn('IF',error)


if __name__=='__main__':
    unittest.main()
