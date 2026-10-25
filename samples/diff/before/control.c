#include "config.h"

int Control_Read(void)
{
    if (g_rpm > g_limit) {
        Legacy_Log();
    }
    return g_rpm;
}

int Monitor_Read(void)
{
    return g_rpm;
}

void Legacy_Log(void)
{
    g_legacy++;
}
