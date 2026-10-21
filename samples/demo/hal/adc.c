#include "demo.h"

/* 采样状态：滤波结果供换挡逻辑使用 */
SensorState g_sensor;

static unsigned char s_scanIdx = 0u;

unsigned short Adc_Filter(unsigned char ch);
void Adc_Scan(void);

void Adc_Init(void)
{
    unsigned char i;

    for (i = 0u; i < ADC_CHANNELS; i++) {
        g_sensor.raw[i] = 0u;
        g_sensor.filtered[i] = 0u;
    }
    g_sensor.valid = 0u;
    g_sensor.channel = 0u;
    s_scanIdx = 0u;
}

/* 启动一轮扫描：每个周期采一个通道 */
void Adc_Start(void)
{
    Adc_Scan();
}

void Adc_Scan(void)
{
    unsigned short v;

    v = (unsigned short)(g_tick * 7u + s_scanIdx * 13u);
    g_sensor.raw[s_scanIdx] = v;
    g_sensor.filtered[s_scanIdx] = Adc_Filter(s_scanIdx);

    s_scanIdx++;
    if (s_scanIdx >= ADC_CHANNELS) {
        s_scanIdx = 0u;
        g_sensor.valid = 1u;
    }
}

/* 一阶低通：新值占 1/4 */
unsigned short Adc_Filter(unsigned char ch)
{
    unsigned short old;
    unsigned short raw;

    old = g_sensor.filtered[ch];
    raw = g_sensor.raw[ch];
    return (unsigned short)((old * 3u + raw) / 4u);
}

/* 读滤波后的值；无效时返回 0 */
unsigned short Adc_Get(unsigned char ch)
{
    if (ch >= ADC_CHANNELS || g_sensor.valid == 0u) {
        return 0u;
    }
    g_sensor.channel = ch;
    return g_sensor.filtered[ch];
}

/* 批量取值，返回通道数 */
unsigned char Adc_GetAll(unsigned short *out, unsigned char max)
{
    unsigned char i;
    unsigned char n = 0u;

    for (i = 0u; i < ADC_CHANNELS && n < max; i++) {
        out[n] = g_sensor.filtered[i];
        n++;
    }
    return n;
}
