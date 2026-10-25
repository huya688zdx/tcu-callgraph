#include "config.h"

int g_rpm = 0;
int g_limit = 120;
int g_fault = 0;

int Normalize(int value)
{
    return value;
}

void Sensor_Update(void)
{
    g_rpm = Normalize(SCALE);
}
