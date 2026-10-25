#include "config.h"

/* 此文件只在总代码目录中，用来验证局部差分之外的数据影响。 */
int Supervisor_Read(void)
{
    return g_rpm;
}
