#include "demo.h"

/* 故障码表：const，只读 */
const unsigned char g_dtcTable[8] = { 0x11u, 0x21u, 0x22u, 0x31u, 0x32u, 0x41u, 0x51u, 0x61u };

/* 诊断上报钩子：由集成方注册，默认指向内置实现 */
DiagHook g_diagHook = 0;

static unsigned char s_dtcCount = 0u;
static unsigned char s_lastDtc = 0u;

void Diag_DefaultReport(unsigned char code);

void Diag_Init(void)
{
    s_dtcCount = 0u;
    s_lastDtc = 0u;
    g_diagHook = Diag_DefaultReport;
}

/* 内置上报：只记录最近一次故障码 */
void Diag_DefaultReport(unsigned char code)
{
    s_lastDtc = code;
    s_dtcCount++;
}

/* 上报故障码：走钩子，便于单测替换 */
void Diag_Report(unsigned char code)
{
    if (g_diagHook != 0) {
        g_diagHook(code);
    }
}

/* 周期诊断：把故障码映射到 DTC 表 */
void Diag_Task(void)
{
    unsigned char i;

    if (g_faultCode == 0) {
        return;
    }

    for (i = 0u; i < 8u; i++) {
        if (g_dtcTable[i] == (unsigned char)g_faultCode) {
            Diag_Report(g_dtcTable[i]);
            break;
        }
    }

    g_faultCode = 0;
}

unsigned char Diag_GetCount(void)
{
    return s_dtcCount;
}

unsigned char Diag_GetLast(void)
{
    return s_lastDtc;
}
