#include "shared.h"

unsigned int g_rpm;
unsigned int g_index;
unsigned int g_samples[4];
static unsigned int s_count;

/* 不调用 Control_Read，通过公共变量把采样结果交给它。 */
void Sensor_Update(void)
{
    s_count++;
    g_rpm = 1200u;
    g_index = s_count % 4u;
    g_samples[g_index] = g_rpm;
}
