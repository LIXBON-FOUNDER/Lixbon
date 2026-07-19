// usage_screen.dart — plan vigente, consumo del período y barras de
// tokens/día (30 días), espejo de "Mi cuenta → Uso" (/api/account/usage).
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../api.dart';
import '../theme.dart';

class UsageScreen extends StatefulWidget {
  const UsageScreen({super.key});

  @override
  State<UsageScreen> createState() => _UsageScreenState();
}

class _UsageScreenState extends State<UsageScreen> {
  Map<String, dynamic>? data;
  String error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<ApiClient>();
    try {
      final res = await api.get('/api/account/usage');
      if (!mounted) return;
      setState(() {
        data = res is Map ? Map<String, dynamic>.from(res) : null;
        error = '';
      });
    } on ApiException catch (err) {
      if (!mounted) return;
      setState(() => error = err.message);
    }
  }

  String _fmt(num? n) {
    if (n == null) return '—';
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}K';
    return n.toString();
  }

  String _fmtDate(dynamic iso) {
    if (iso is! String) return '';
    final d = DateTime.tryParse(iso);
    if (d == null) return '';
    final local = d.toLocal();
    return '${local.day.toString().padLeft(2, '0')}/${local.month.toString().padLeft(2, '0')}/${local.year}';
  }

  @override
  Widget build(BuildContext context) {
    final c = LixColors.of(context);
    final plan = data?['plan'];
    final usage = data?['usage'];

    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: RefreshIndicator(
          color: c.ink,
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(18, 10, 18, 30),
            children: [
              Text(
                'Uso',
                style: TextStyle(
                  color: c.ink,
                  fontFamily: kFontUi,
                  fontWeight: FontWeight.w600,
                  fontSize: 22,
                ),
              ),
              const SizedBox(height: 14),
              if (data == null && error.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 40),
                  child: Center(child: CircularProgressIndicator(color: c.inkSoft)),
                ),
              if (error.isNotEmpty)
                Text(error,
                    style: TextStyle(color: c.danger, fontFamily: kFontUi, fontSize: 14)),
              if (plan is Map) ...[
                _card(c, background: c.bgSecondary, children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('Plan actual',
                          style: TextStyle(
                            color: c.ink,
                            fontFamily: kFontUi,
                            fontWeight: FontWeight.w600,
                            fontSize: 16,
                          )),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                        decoration: BoxDecoration(
                          color: c.accent,
                          borderRadius: BorderRadius.circular(kRadiusPill),
                        ),
                        child: Text(
                          (plan['name'] ?? plan['id'] ?? '').toString(),
                          style: TextStyle(
                            color: c.onAccent,
                            fontFamily: kFontUi,
                            fontWeight: FontWeight.w500,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  InkWell(
                    onTap: () {
                      final api = context.read<ApiClient>();
                      launchUrl(Uri.parse('${api.base}/planes'),
                          mode: LaunchMode.externalApplication);
                    },
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('Ver planes y mejoras',
                            style: TextStyle(
                              color: c.accentDeep,
                              fontFamily: kFontUi,
                              fontWeight: FontWeight.w500,
                              fontSize: 13,
                            )),
                        const SizedBox(width: 4),
                        Icon(Icons.open_in_new, size: 13, color: c.accentDeep),
                      ],
                    ),
                  ),
                ]),
                const SizedBox(height: 14),
              ],
              if (usage is Map) ...[
                _card(c, children: [
                  _cardTitle(c, 'Mensajes de hoy'),
                  const SizedBox(height: 10),
                  _progress(c, usage['messages_today'], usage['messages_per_day']),
                  if (usage['day_resets_at'] != null) ...[
                    const SizedBox(height: 6),
                    _resetNote(c, 'Se reinicia el ${_fmtDate(usage['day_resets_at'])}'),
                  ],
                ]),
                const SizedBox(height: 14),
                _card(c, children: [
                  _cardTitle(c, 'Tokens del mes'),
                  const SizedBox(height: 10),
                  _progress(c, usage['tokens_month'], usage['tokens_per_month']),
                  if (usage['month_resets_at'] != null) ...[
                    const SizedBox(height: 6),
                    _resetNote(c, 'Se reinicia el ${_fmtDate(usage['month_resets_at'])}'),
                  ],
                ]),
                const SizedBox(height: 14),
              ],
              if (data != null)
                _card(c, children: [
                  _cardTitle(c, 'Tokens por día (30 días)'),
                  const SizedBox(height: 12),
                  _DailyChart(daily: data!['daily'], colors: c),
                ]),
            ],
          ),
        ),
      ),
    );
  }

  Widget _card(LixColors c, {Color? background, required List<Widget> children}) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: background ?? c.bg,
        borderRadius: BorderRadius.circular(kRadiusBox),
        border: Border.all(color: c.borderSoft),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
    );
  }

  Widget _cardTitle(LixColors c, String text) => Text(
        text,
        style: TextStyle(
          color: c.ink,
          fontFamily: kFontUi,
          fontWeight: FontWeight.w600,
          fontSize: 15,
        ),
      );

  Widget _resetNote(LixColors c, String text) => Text(
        text,
        style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 11),
      );

  Widget _progress(LixColors c, dynamic used, dynamic limit) {
    final usedN = used is num ? used : 0;
    final limitN = limit is num ? limit : 0;
    final unlimited = limitN <= 0;
    final ratio = unlimited ? 0.0 : (usedN / limitN).clamp(0.0, 1.0).toDouble();
    final nearLimit = !unlimited && ratio >= 0.85;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(kRadiusPill),
          child: LinearProgressIndicator(
            value: unlimited ? 0 : ratio,
            minHeight: 8,
            backgroundColor: c.borderSoft,
            color: nearLimit ? c.danger : c.accentDeep,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          '${_fmt(usedN)} de ${unlimited ? 'ilimitado' : _fmt(limitN)}',
          style: TextStyle(color: c.inkMuted, fontFamily: kFontUi, fontSize: 12),
        ),
      ],
    );
  }
}

class _DailyChart extends StatelessWidget {
  final dynamic daily;
  final LixColors colors;
  const _DailyChart({required this.daily, required this.colors});

  @override
  Widget build(BuildContext context) {
    final byDate = <String, num>{};
    if (daily is List) {
      for (final row in daily as List) {
        if (row is Map && row['usage_date'] is String) {
          final key = row['usage_date'] as String;
          final tokens = row['total_tokens'];
          byDate[key] = (byDate[key] ?? 0) + (tokens is num ? tokens : 0);
        }
      }
    }
    final today = DateTime.now();
    final data = List<num>.generate(30, (i) {
      final d = today.subtract(Duration(days: 29 - i));
      final key = '${d.year.toString().padLeft(4, '0')}-'
          '${d.month.toString().padLeft(2, '0')}-'
          '${d.day.toString().padLeft(2, '0')}';
      return byDate[key] ?? 0;
    });
    final max = data.fold<num>(1, (a, b) => b > a ? b : a);
    const chartHeight = 110.0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: chartHeight,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: data.map((tokens) {
              final h = tokens > 0
                  ? (chartHeight * tokens / max).clamp(3.0, chartHeight).toDouble()
                  : 1.0;
              return Expanded(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 1.5),
                  child: Container(
                    height: h,
                    decoration: BoxDecoration(
                      color: tokens > 0 ? colors.accentDeep : colors.borderSoft,
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('hace 30 días',
                style: TextStyle(color: colors.inkMuted, fontFamily: kFontUi, fontSize: 11)),
            Text('hoy',
                style: TextStyle(color: colors.inkMuted, fontFamily: kFontUi, fontSize: 11)),
          ],
        ),
      ],
    );
  }
}
